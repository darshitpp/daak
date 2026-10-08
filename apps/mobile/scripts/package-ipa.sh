#!/usr/bin/env bash
#
# Build an UNSIGNED iOS .ipa for Daak.
#
# There is no paid Apple Developer Program. There is no iOS Distribution
# certificate. So this script must NOT sign the app and must NOT notarize it.
# The user sideloads the .ipa with AltStore or SideStore, which re-signs it
# with a free Apple ID.
#
# The DEVICE entitlements file requests no App Group. A free team grants no
# App Group. So an .ipa that requests the key fails to install.
#
# The share extension is not embedded. The built app must hold no PlugIns
# directory and no .appex.
set -euo pipefail

# The repository root, from this file's own path.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

# The version comes from release/version.json, the single source of truth.
VERSION="$(node -p 'require("./release/version.json").version')"

# One fixed scratch directory. Reuse it on every run. A per-attempt path fills
# the disk, and a full disk kills an Xcode build with no error message.
SCRATCH="${TMPDIR%/}/daak"
DERIVED="$SCRATCH/dd_ios"
ARCHIVE="$DERIVED/Daak-ios.xcarchive"
APP="$ARCHIVE/Products/Applications/Daak.app"
IPA_DIR="$SCRATCH/ipa"
IPA="$IPA_DIR/Daak-$VERSION.ipa"
STAGE="$SCRATCH/ipa-stage"

mkdir -p "$IPA_DIR"

# Archive with signing OFF. Xcode must not sign the app, because no iOS
# Distribution certificate exists.
xcodebuild -workspace apps/mobile/ios/Daak.xcworkspace \
  -scheme Daak \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
  archive

test -d "$APP"

# The share extension must not be embedded. A free profile grants no App Group,
# so an embedded extension cannot share a container and fails to install.
test ! -d "$APP/PlugIns"
if [ -n "$(find "$APP" -name '*.appex' -print -quit)" ]; then
  echo "package-ipa: the app embeds an .appex." >&2
  exit 1
fi

# No provisioning profile may be embedded.
test ! -f "$APP/embedded.mobileprovision"

# The app executable must be ARM64 device code.
ARCH_INFO="$(lipo -info "$APP/Daak" 2>/dev/null || true)"
if ! grep -q arm64 <<<"$ARCH_INFO"; then
  echo "package-ipa: the app executable is not arm64." >&2
  exit 1
fi

# Build the .ipa. Stage the app under a Payload directory, then zip the stage.
rm -rf "$STAGE"
mkdir -p "$STAGE/Payload"
cp -R "$APP" "$STAGE/Payload/"
( cd "$STAGE" && zip -qry "$IPA" Payload )
rm -rf "$STAGE"

echo "IPA: $IPA"
echo "IPA size: $(stat -f '%z' "$IPA") bytes"
echo "SHA-256: $(shasum -a 256 "$IPA" | awk '{print $1}')"
