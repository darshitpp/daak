#!/usr/bin/env bash
#
# Write the SideStore and AltStore source file (source.json) for one release.
#
#   scripts/gen-source.sh <ipa> <version.json> <out>
#
# The script reads the built .ipa and release/version.json. It checks that they
# agree, then writes <out>. SideStore checks the size, the SHA-256, the bundle
# id, the version, and the build number of the download against this file. A
# wrong value blocks the install.
#
# Exit 0: <out> is written. <out> is written last, after every check passes.
# Exit 1: the .ipa and version.json disagree, or a value has a bad format, or
#         the .ipa has not exactly 1 Payload/*.app/Info.plist.
# Exit 2: wrong arguments, a file is missing, or the .ipa is not a zip.
#
# macOS only: plutil reads the plist and stat -f reads the size.
set -euo pipefail

[ $# -eq 3 ] || { echo "usage: $0 <ipa> <version.json> <out>" >&2; exit 2; }
ipa="$1"; version_json="$2"; out="$3"

# The values below are the same for every release.
REPO=darshitpp/daak
APP_ID=dev.darshit.daak
SOURCE_URL="https://github.com/$REPO/releases/latest/download/source.json"
ICON_PATH=apps/desktop/macos/Daak-macOS/Assets.xcassets/AppIcon.appiconset/icon_512x512%402x.png
# ponytail: the description is a constant. Parse the README only if it must follow the README.
DESCRIPTION="Encrypted file and text sharing on your local network."
MIN_OS=16.0

err() { echo "gen-source: $*" >&2; }

[ -f "$ipa" ] || { err "error: not a readable file: $ipa"; exit 2; }
[ -f "$version_json" ] || { err "error: not a readable file: $version_json"; exit 2; }
unzip -tq -- "$ipa" >/dev/null 2>&1 || { err "error: not a zip file: $ipa"; exit 2; }

# The expected values come from release/version.json.
version="$(jq -r '.version' "$version_json")" || { err "error: cannot read version from $version_json"; exit 2; }
build="$(jq -r '.buildNumber | tostring' "$version_json")" || { err "error: cannot read buildNumber from $version_json"; exit 2; }
printf '%s' "$version" | grep -qE '^[0-9]+(\.[0-9]+){1,2}$' || { err "error: bad version format: $version"; exit 1; }
printf '%s' "$build" | grep -qE '^[0-9]+$' || { err "error: bad build number format: $build"; exit 1; }

# Find exactly 1 Payload/<name>.app/Info.plist. A nested plist does not match.
entries="$(unzip -Z1 -- "$ipa" | grep -xE 'Payload/[^/]+\.app/Info\.plist' || true)"
count="$(printf '%s' "$entries" | grep -c . || true)"
[ "$count" -eq 1 ] || { err "error: the .ipa has $count Payload/*.app/Info.plist entries, want 1"; exit 1; }

# Read one key from the plist. The pipe reads at most 1 MiB and writes no file.
plist_value() {
  unzip -p -- "$ipa" "$entries" | head -c 1048576 | plutil -extract "$1" raw -o - - 2>/dev/null \
    || { err "error: cannot read $1 from $entries"; exit 1; }
}
ipa_version="$(plist_value CFBundleShortVersionString)"
ipa_build="$(plist_value CFBundleVersion)"
ipa_id="$(plist_value CFBundleIdentifier)"

[ "$ipa_version" = "$version" ] || { err "error: CFBundleShortVersionString is $ipa_version, version.json says $version"; exit 1; }
[ "$ipa_build" = "$build" ] || { err "error: CFBundleVersion is $ipa_build, version.json says $build"; exit 1; }
[ "$ipa_id" = "$APP_ID" ] || { err "error: CFBundleIdentifier is $ipa_id, want $APP_ID"; exit 1; }

tag="v$version"
size="$(stat -f %z "$ipa")"
sum="$(shasum -a 256 -- "$ipa" | awk '{print $1}')"

json="$(jq -n \
  --arg sourceURL "$SOURCE_URL" \
  --arg appId "$APP_ID" \
  --arg desc "$DESCRIPTION" \
  --arg icon "https://raw.githubusercontent.com/$REPO/$tag/$ICON_PATH" \
  --arg version "$version" \
  --arg build "$build" \
  --arg date "$(date -u +%Y-%m-%d)" \
  --arg url "https://github.com/$REPO/releases/download/$tag/Daak-$version.ipa" \
  --argjson size "$size" \
  --arg sha "$sum" \
  --arg minos "$MIN_OS" \
  '{
    name: "Daak",
    sourceURL: $sourceURL,
    apps: [{
      name: "Daak",
      bundleIdentifier: $appId,
      developerName: "Darshit",
      localizedDescription: $desc,
      iconURL: $icon,
      versions: [{
        version: $version,
        buildVersion: $build,
        date: $date,
        downloadURL: $url,
        size: $size,
        sha256: $sha,
        minOSVersion: $minos
      }]
    }]
  }')"
printf '%s\n' "$json" > "$out"
