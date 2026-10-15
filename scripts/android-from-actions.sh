#!/usr/bin/env bash
#
# Start the Android build and signing run on GitHub, wait for it, download the
# signed APKs, and check them.
#
#   scripts/android-from-actions.sh <version> <sha> <out-dir>
#
# <sha> must be the head of origin/main. The run builds that commit. The
# environment "release" waits for the user to approve the run in GitHub.
#
# NEVER add `set -x`. NEVER print a secret. This script reads no secret.
set -euo pipefail

REPO=darshitpp/daak
WORKFLOW=release.yml
GH="${GH:-gh}"
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
BT="$SDK/build-tools/35.0.0"
APKSIGNER="${APKSIGNER:-$BT/apksigner}"
AAPT="${AAPT:-$BT/aapt}"
AAPT2="${AAPT2:-$BT/aapt2}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

die() { echo "android-from-actions: $*" >&2; exit 1; }

# The signer fingerprint has one source: EXPECTED_SIGNER in the workflow.
expected_signer() {
  sed -n 's/^ *EXPECTED_SIGNER: *\([0-9a-f]\{64\}\) *$/\1/p' "$ROOT/.github/workflows/$WORKFLOW" | head -1
}

# stdin: `gh run list --json databaseId,createdAt`. $1: the time before the
# dispatch. Prints the id of the newest run that started after that time.
pick_run() {
  jq -r --arg t "$1" '[.[] | select(.createdAt >= $t)] | sort_by(.createdAt) | last | .databaseId // empty'
}

# $1: run id. Polls until the run ends. Fails on a bad conclusion or at the
# deadline. The environment waits for the user, so the deadline is long.
wait_run() {
  local id="$1" deadline now state status conclusion
  now="$(date +%s)"
  deadline=$((now + ${DAAK_WAIT_SECONDS:-5400}))
  while :; do
    state="$("$GH" run view "$id" --repo "$REPO" --json status,conclusion)"
    status="$(printf '%s' "$state" | jq -r .status)"
    conclusion="$(printf '%s' "$state" | jq -r .conclusion)"
    if [ "$status" = completed ]; then
      [ "$conclusion" = success ] || { echo "the run ended with: $conclusion" >&2; return 1; }
      return 0
    fi
    echo "run $id: $status"
    [ "$(date +%s)" -lt "$deadline" ] || { echo "no result before the deadline. Did you approve the environment?" >&2; return 1; }
    sleep "${DAAK_POLL_SECONDS:-30}"
  done
}

# $1: APK file. $2: version. Checks the signer, the version, and the dev server address.
verify_apk() {
  local apk="$1" version="$2" want got name ip
  want="$(expected_signer)"
  [ -n "$want" ] || { echo "cannot read EXPECTED_SIGNER from the workflow" >&2; return 1; }
  got="$("$APKSIGNER" verify --print-certs "$apk" | sed -n 's/.*certificate SHA-256 digest: //p' | head -1)"
  [ "$got" = "$want" ] || { echo "$apk: signer $got is not $want" >&2; return 1; }
  name="$("$AAPT" dump badging "$apk" | sed -n "s/^package: .*versionName='\([^']*\)'.*/\1/p")"
  [ "$name" = "$version" ] || { echo "$apk: versionName $name is not $version" >&2; return 1; }
  ip="$("$AAPT2" dump resources "$apk" | sed -n '/string\/react_native_dev_server_ip/{n;s/.*"\(.*\)"/\1/p;}')"
  [ "$ip" = localhost ] || { echo "$apk: dev server address is '$ip', not localhost" >&2; return 1; }
}

[ "${DAAK_SOURCE_ONLY:-}" = 1 ] && return 0 2>/dev/null || true

[ $# -eq 3 ] || { echo "usage: $0 <version> <sha> <out-dir>" >&2; exit 2; }
VERSION="$1"
SHA="$2"
OUT="$3"

command -v jq >/dev/null || die "missing tool: jq"
[ -x "$APKSIGNER" ] || die "no apksigner at $APKSIGNER. Set ANDROID_HOME."

git -C "$ROOT" fetch -q origin main
[ "$(git -C "$ROOT" rev-parse origin/main)" = "$SHA" ] \
  || die "origin/main is not $SHA. Push main first, and build the head of main."

names=("daak-$VERSION-arm64-v8a.apk" "daak-$VERSION-armeabi-v7a.apk" "daak-$VERSION-universal.apk")
mkdir -p "$OUT"
# A stale APK from an earlier local build must never reach the release.
for n in "${names[@]}"; do rm -f "$OUT/$n"; done

before="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
"$GH" workflow run "$WORKFLOW" --repo "$REPO" --ref main -f ref="$SHA"

id=""
for _ in $(seq 1 24); do
  sleep "${DAAK_POLL_SECONDS:-5}"
  id="$("$GH" run list --repo "$REPO" --workflow "$WORKFLOW" --event workflow_dispatch --limit 20 \
        --json databaseId,createdAt | pick_run "$before")"
  [ -n "$id" ] && break
done
[ -n "$id" ] || die "the run did not start"
echo "run $id: https://github.com/$REPO/actions/runs/$id"
echo "Approve the environment 'release' in GitHub. The script waits."

wait_run "$id" || die "the run failed or timed out"
"$GH" run download "$id" --repo "$REPO" -n android-signed -D "$OUT"

for n in "${names[@]}"; do
  [ -s "$OUT/$n" ] || die "the run did not give $n"
  verify_apk "$OUT/$n" "$VERSION" || die "check failed for $n"
done
echo "android-from-actions: 3 signed APKs in $OUT"
