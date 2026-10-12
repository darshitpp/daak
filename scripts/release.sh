#!/usr/bin/env bash
#
# One command for a whole Daak release: build, sign, hash, tag, GitHub Release,
# Homebrew cask, F-Droid merge request.
#
#   scripts/release.sh <version> [--from N] [--to N]
#
# <version> must equal release/version.json. Bump that file, run
# `node scripts/stamp-version.mjs`, and commit before you run this script.
#
# Stages 1 to 8 change only local files. Stages 9 to 12 are OUT stages: they
# publish something. Each OUT stage prints what it will do and waits for `y`.
# There is no --yes flag. The prompt is the approval.
#
# The script is safe to run again. Each OUT stage reads the remote state first
# and skips work that is done. Use --from 9 to restart at the OUT stages.
#
# NEVER add `set -x`. The signing script reads a password from the Keychain.
set -euo pipefail

VERSION="${1:-}"
[ -n "$VERSION" ] || { echo "usage: scripts/release.sh <version> [--from N] [--to N]" >&2; exit 2; }
shift
FROM=1
TO=12
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --to) TO="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

cd "$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$PWD"
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"

REPO=darshitpp/daak
TAP=darshitpp/tap
TAP_REPO=darshitpp/homebrew-tap
APP_ID=dev.darshit.daak
SCRATCH="${TMPDIR%/}/daak"
mkdir -p "$SCRATCH"

APK_DIR="$ROOT/apps/mobile/android/app/build/outputs/apk/release"
APK_ARM64="$APK_DIR/daak-$VERSION-arm64-v8a.apk"
APK_ARM32="$APK_DIR/daak-$VERSION-armeabi-v7a.apk"
APK_UNI="$APK_DIR/daak-$VERSION-universal.apk"
DMG="$SCRATCH/dmg/Daak-$VERSION.dmg"
IPA="$SCRATCH/ipa/Daak-$VERSION.ipa"
SUMS="release/sha256-$VERSION.txt"
TAG="v$VERSION"

say() { printf '\n== stage %s: %s\n' "$1" "$2"; }
die() { echo "release: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing tool: $1. $2"; }
run() { [ "$1" -ge "$FROM" ] && [ "$1" -le "$TO" ]; }

# The only approval. Reads from the terminal, so a pipe cannot answer it.
ask() {
  printf '%s [y/N] ' "$1"
  local a
  read -r a < /dev/tty || return 1
  [ "$a" = y ]
}

sha() { shasum -a 256 "$1" | awk '{print $1}'; }

# ---------------------------------------------------------------- 1: tools ---
if run 1; then
  say 1 "check the tools"
  need git "Install Git."
  need node "Install Node."
  need pnpm "Install pnpm 9.12.0."
  need cargo "Install Rust."
  need jq "Install jq."
  need gh "Run: brew install gh"
  gh auth status >/dev/null 2>&1 || die "gh is not logged in. Run: gh auth login"
  [ "$(jq -r .version release/version.json)" = "$VERSION" ] \
    || die "release/version.json does not say $VERSION"
fi

# ------------------------------------------------------------ 2: clean tree ---
if run 2; then
  say 2 "check the tree"
  [ "$(git rev-parse --abbrev-ref HEAD)" = main ] || die "the branch is not main"
  [ -z "$(git status --porcelain)" ] || die "the tree is not clean. Commit or stash first."
fi

# ------------------------------------------------------------- 3: version ---
if run 3; then
  say 3 "check the version stamp"
  node scripts/stamp-version.mjs --check
fi

# --------------------------------------------------------------- 4: gates ---
if run 4; then
  say 4 "run the build gates"
  ulimit -n 10240 || true
  cargo fmt --all --check
  cargo clippy --all-targets -- -D warnings
  cargo test --workspace
  pnpm -r typecheck
  pnpm -r test
  bash proto/codegen.sh
  git diff --exit-code -- proto/gen
fi

# ------------------------------------------------------------ 5: artifacts ---
if run 5; then
  say 5 "build and sign the artifacts"
  free_gib="$(( $(df -Pk "$SCRATCH" | awk 'NR==2 {print $4}') / 1048576 ))"
  [ "$free_gib" -ge 10 ] || die "only ${free_gib}GiB free. A native build needs 10 GiB. See AGENTS.md, environment defect 4."
  ./scripts/sign-android.sh
  bash apps/desktop/macos/scripts/package-dmg.sh
  bash apps/mobile/scripts/package-ipa.sh
fi

# ----------------------------------------------------------------- 6: sums ---
if run 6; then
  say 6 "hash the artifacts"
  for f in "$APK_ARM64" "$APK_ARM32" "$APK_UNI" "$DMG" "$IPA"; do
    [ -s "$f" ] || die "missing artifact: $f"
  done
  : > "$SUMS"
  for f in "$APK_ARM64" "$APK_ARM32" "$APK_UNI" "$DMG" "$IPA"; do
    printf '%s  %s\n' "$(sha "$f")" "$(basename "$f")" >> "$SUMS"
  done
  cat "$SUMS"
fi

# ---------------------------------------------------------------- 7: files ---
# The recipe and the cask live in other repositories. Stages 11 and 12 fill the
# copies in this repository (fdroid/ and release/homebrew/) in their own clones.
# This stage only checks that the templates exist and the versionCode matches.
if run 7; then
  say 7 "check the store templates"
  [ -f fdroid/$APP_ID.yml ] || die "missing fdroid/$APP_ID.yml"
  [ -f release/homebrew/daak.rb ] || die "missing release/homebrew/daak.rb"
  [ -d fastlane/metadata/android/en-US ] || die "missing the fastlane listing"
  base="$(sed -n 's/^ *versionCode \([0-9][0-9]*\)$/\1/p' apps/mobile/android/app/build.gradle)"
  [ -n "$base" ] || die "cannot read versionCode"
  for off in 0 1 2; do
    [ -f "fastlane/metadata/android/en-US/changelogs/$((base * 10 + off)).txt" ] \
      || die "missing changelog $((base * 10 + off)).txt"
  done
fi

# --------------------------------------------------------------- 8: checks ---
# fdroid lint and brew audit need the clones from stages 11 and 12. They run
# there, before any push, and stop the script on failure.
if run 8; then
  say 8 "checks that run inside stages 11 and 12"
  echo "nothing to do here"
fi

# ----------------------------------------------------- 9: OUT: commit, tag ---
if run 9; then
  say 9 "OUT: commit the hashes, push main and the tag $TAG"
  git add "$SUMS"
  if ! git diff --cached --quiet; then
    git commit -m "docs(release): record the $VERSION artifact hashes"
  fi
  ask "Push main and tag $TAG to origin?" || die "stopped by the user"
  git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || git tag -a "$TAG" -m "Daak $VERSION"
  git push origin main
  if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
    echo "tag $TAG is already on origin. Skipping."
  else
    git push origin "$TAG"
  fi
fi

# ------------------------------------------------- 10: OUT: GitHub Release ---
if run 10; then
  say 10 "OUT: upload the files to the GitHub Release and publish it"
  # release.yml makes a draft when the tag lands. Wait up to 60 s for it.
  n=0
  until gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; do
    n=$((n + 1))
    if [ "$n" -gt 12 ]; then
      gh release create "$TAG" --repo "$REPO" --draft --title "Daak $TAG" --generate-notes
      break
    fi
    sleep 5
  done
  ask "Upload 5 files to $TAG?" || die "stopped by the user"
  gh release upload "$TAG" --repo "$REPO" --clobber \
    "$APK_ARM64" "$APK_ARM32" "$APK_UNI" "$DMG" "$IPA"
  if [ "$(gh release view "$TAG" --repo "$REPO" --json isDraft --jq .isDraft)" = true ]; then
    flags=
    ask "Mark $TAG as a pre-release?" && flags=--prerelease
    ask "Publish $TAG now?" || die "stopped by the user"
    # shellcheck disable=SC2086
    gh release edit "$TAG" --repo "$REPO" --draft=false $flags
  fi
fi

# ---------------------------------------------------- 11: OUT: Homebrew cask ---
if run 11; then
  say 11 "OUT: update the cask in $TAP_REPO"
  need brew "Install Homebrew."
  brew tap "$TAP" >/dev/null 2>&1 || die "cannot tap $TAP. Create the repository $TAP_REPO first."
  tap_dir="$(brew --repository "$TAP")"
  git -C "$tap_dir" pull --ff-only
  mkdir -p "$tap_dir/Casks"
  remote_sum="$(gh release download "$TAG" --repo "$REPO" --pattern "Daak-$VERSION.dmg" --output - | shasum -a 256 | awk '{print $1}')"
  [ "$remote_sum" = "$(sha "$DMG")" ] || die "the published .dmg differs from the local .dmg"
  sed -e "s/^  version \".*\"/  version \"$VERSION\"/" \
      -e "s/@SHA256@/$remote_sum/" \
      -e "s/^  sha256 \"[0-9a-f]\{64\}\"/  sha256 \"$remote_sum\"/" \
      release/homebrew/daak.rb > "$tap_dir/Casks/daak.rb"
  brew audit --cask --strict --online "$TAP/daak"
  git -C "$tap_dir" diff
  if [ -z "$(git -C "$tap_dir" status --porcelain Casks/daak.rb)" ]; then
    echo "the cask is up to date. Skipping."
  else
    ask "Commit and push the cask to $TAP_REPO?" || die "stopped by the user"
    git -C "$tap_dir" add Casks/daak.rb
    git -C "$tap_dir" commit -m "daak $VERSION"
    git -C "$tap_dir" push
  fi
fi

# -------------------------------------------------- 12: OUT: F-Droid merge ---
if run 12; then
  say 12 "OUT: open the fdroiddata merge request"
  need glab "Run: brew install glab, then glab auth login"
  need fdroid "Install fdroidserver: pipx install fdroidserver"
  commit="$(git rev-parse "$TAG^{commit}")"
  git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1 \
    || die "tag $TAG is not on origin. Run stage 9 first."
  base="$(sed -n 's/^ *versionCode \([0-9][0-9]*\)$/\1/p' apps/mobile/android/app/build.gradle)"

  # Fill the template: the commit, and the version and versionCode of each entry.
  filled="$SCRATCH/$APP_ID.yml"
  sed -e "s/COMMIT_HASH/$commit/g" \
      -e "s/0\.1\.1/$VERSION/g" \
      -e "s/versionCode: 22/versionCode: $((base * 10 + 2))/" \
      -e "s/versionCode: 21/versionCode: $((base * 10 + 1))/" \
      -e "s/^CurrentVersionCode: .*/CurrentVersionCode: $((base * 10 + 2))/" \
      fdroid/$APP_ID.yml > "$filled"

  me="$(glab api user | jq -r .username)"
  existing="$(glab mr list --repo fdroid/fdroiddata --author "$me" --search "$APP_ID" 2>/dev/null || true)"
  if [ -n "$existing" ]; then
    echo "an open merge request already exists:"
    echo "$existing"
    die "update it by hand. The filled recipe is at $filled"
  fi

  glab repo fork fdroid/fdroiddata --clone=false >/dev/null 2>&1 || true
  fork="$SCRATCH/fdroiddata"
  [ -d "$fork/.git" ] || git clone --depth 1 "https://gitlab.com/$me/fdroiddata.git" "$fork"
  git -C "$fork" remote get-url upstream >/dev/null 2>&1 \
    || git -C "$fork" remote add upstream https://gitlab.com/fdroid/fdroiddata.git
  git -C "$fork" fetch --depth 1 upstream master
  git -C "$fork" checkout -B "$APP_ID" upstream/master
  if [ -f "$fork/metadata/$APP_ID.yml" ]; then
    echo "metadata/$APP_ID.yml exists upstream."
    echo "This is an update. Add the new Builds entries by hand from $filled."
    exit 1
  fi
  cp "$filled" "$fork/metadata/$APP_ID.yml"
  ( cd "$fork" && fdroid lint "$APP_ID" )
  ( cd "$fork" && fdroid build -v -l "$APP_ID" )

  # The merge request text holds the user's own statements. Open it in the
  # editor so the user reads each item and ticks it. The script never ticks.
  body="$SCRATCH/mr-body.md"
  template="$fork/.gitlab/merge_request_templates/App inclusion.md"
  [ -f "$template" ] || template="$(ls "$fork"/.gitlab/merge_request_templates/*.md | head -1)"
  cp "$template" "$body"
  "${EDITOR:-vi}" "$body"

  git -C "$fork" diff --stat
  ask "Push the branch to your fork and open the merge request?" || die "stopped by the user"
  git -C "$fork" add "metadata/$APP_ID.yml"
  git -C "$fork" commit -m "New app: Daak ($APP_ID)"
  git -C "$fork" push --force-with-lease origin "$APP_ID"
  glab mr create --repo fdroid/fdroiddata --source-branch "$APP_ID" --target-branch master \
    --title "New app: Daak ($APP_ID)" --description "$(cat "$body")" --yes
  echo "Done. F-Droid CI and a maintainer review the merge request. Publication is a later stage."
fi

echo
echo "release.sh $VERSION: stages $FROM to $TO finished."
