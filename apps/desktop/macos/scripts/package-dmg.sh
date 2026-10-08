#!/usr/bin/env bash
#
# Build a signed, un-notarized macOS .dmg for Daak.
#
# The free release path has no Developer ID certificate. So the app is signed
# with the Apple Development certificate, and the .dmg is NOT notarized. This
# script must NOT call notarytool and must NOT call stapler: no notarization
# credential exists, and the secure timestamp server is unreachable.
#
# This script must NOT add the hardened runtime. `--options runtime` needs the
# JIT entitlements. The app entitlements do not grant them. So the Hermes
# engine can crash at start.
#
# This script must NOT use `--timestamp`. Network access is restricted, and the
# secure timestamp server is unreachable.
#
# The archive step signs the app through automatic signing. This script only
# verifies that signature. It does not re-sign the app.
set -euo pipefail

# The repository root, from this file's own path.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$REPO_ROOT"

# The version comes from release/version.json, the single source of truth.
VERSION="$(node -p 'require("./release/version.json").version')"

# One fixed scratch directory. Reuse it on every run. A per-attempt path fills
# the disk, and a full disk kills an Xcode build with no error message.
SCRATCH="${TMPDIR%/}/daak"
DERIVED="$SCRATCH/dd_macos"
ARCHIVE="$DERIVED/Daak.xcarchive"
APP="$ARCHIVE/Products/Applications/Daak.app"
DMG_DIR="$SCRATCH/dmg"
DMG="$DMG_DIR/Daak-$VERSION.dmg"
STAGE="$SCRATCH/dmg-stage"

# The signing identity. Exactly one development identity exists on this host.
# The DMG sign falls back to this exact name when the Keychain query is empty.
# Read the whole output into a variable first. A `sed ... | head -1` pipeline
# is unsafe under `set -o pipefail`: an early `head` exit sends SIGPIPE to sed,
# the pipeline status becomes non-zero, and `set -e` stops the script.
IDENTITY_INFO="$(security find-identity -v -p codesigning 2>/dev/null || true)"
IDENTITY_LINES="$(sed -n 's/.*"\(Apple Development:.*\)"/\1/p' <<<"$IDENTITY_INFO")"
IDENTITY="${IDENTITY_LINES%%$'\n'*}"
if [ -z "$IDENTITY" ]; then
  IDENTITY="Apple Development: darshit12@gmail.com (9VTBKNCJJ2)"
fi

mkdir -p "$DMG_DIR"

# Archive. Xcode signs the app with the Apple Development certificate through
# automatic signing. The project sets ProvisioningStyle = Automatic.
xcodebuild -workspace apps/desktop/macos/Daak.xcworkspace \
  -scheme Daak-macOS \
  -configuration Release \
  -archivePath "$ARCHIVE" \
  -derivedDataPath "$DERIVED" \
  archive

test -d "$APP"

# Verify the signature that Xcode produced. This script must not re-sign.
codesign --verify --deep --strict --verbose=2 "$APP"

# Assert the authority. An ad-hoc signature grants no keychain group, so the
# app fails at the first keychain write. Fail when the authority is not Apple
# Development.
# Capture the output into a variable. A `codesign ... | grep -q` pipe makes
# codesign take SIGPIPE when grep exits early, and `set -o pipefail` then
# reports the pipeline as failed even when grep matched.
SIGN_INFO="$(codesign -dv --verbose=4 "$APP" 2>&1 || true)"
if ! grep -q 'Authority=Apple Development' <<<"$SIGN_INFO"; then
  echo "package-dmg: the app is not signed with an Apple Development certificate." >&2
  exit 1
fi

# Build the image. Stage the app and an /Applications symlink, then create a
# compressed read-only image.
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/Daak.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Daak" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
rm -rf "$STAGE"

hdiutil verify "$DMG"

# Sign the image itself. A user who mounts the image gets a signature on the
# outer container. The app inside keeps the Xcode signature.
codesign --force --sign "$IDENTITY" "$DMG"
codesign --verify --verbose=2 "$DMG"

# The Gatekeeper verdict is recorded for the release notes. The expected
# verdict is REJECTED, because the app is not notarized. This check must NOT
# fail the script.
echo '--- spctl: dmg ---'
spctl -a -t open --context context:primary-signature -vv "$DMG" 2>&1 || true
echo '--- spctl: app ---'
spctl -a -t exec -vv "$APP" 2>&1 || true

echo "DMG: $DMG"
echo "DMG size: $(stat -f '%z' "$DMG") bytes"
echo "SHA-256: $(shasum -a 256 "$DMG" | awk '{print $1}')"
