#!/usr/bin/env bash
#
# Build and sign the Android release APK with the upload key.
# This script is the manual fallback. It builds on macOS, so the APK does not
# equal the F-Droid build. `release.sh` uses the GitHub run instead.
#
# NEVER add `set -x` to this file. NEVER print a password.
# `set -x` prints every expanded value. The password export lines below would
# then write the password to the terminal, to the CI log, and to every file the
# caller redirects the output to.
#
# The store password is read ONCE from the macOS login Keychain. Nobody types
# it. It is never passed on a command line, where `ps` would show it. It is
# never written to a file. `security find-generic-password -w` writes only the
# value to standard output, with no trailing newline.
#
# The key password equals the store password. So both Gradle variables hold the
# same value.
set -euo pipefail

# The caller sets these. Set JAVA_HOME to a JDK 17, ANDROID_HOME to the Android
# SDK, and ANDROID_KEYSTORE_PATH to the upload keystore.
: "${JAVA_HOME:?sign-android: set JAVA_HOME to a JDK 17}"
: "${ANDROID_HOME:?sign-android: set ANDROID_HOME to the Android SDK}"
: "${ANDROID_KEYSTORE_PATH:?sign-android: set ANDROID_KEYSTORE_PATH to the upload keystore}"
export JAVA_HOME ANDROID_HOME ANDROID_KEYSTORE_PATH
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_KEY_ALIAS="${ANDROID_KEY_ALIAS:-daak}"
KEYCHAIN_SERVICE="${ANDROID_KEYCHAIN_SERVICE:-daak-android-upload}"
KEYCHAIN_ACCOUNT="${ANDROID_KEYCHAIN_ACCOUNT:-daak}"

# Read the store password. The assignment is the command substitution, so a
# missing Keychain item takes the failure branch instead of leaving an empty
# value to Gradle. The -a and -s values must match the item that
# `security add-generic-password` created. See release/README.md.
if ! ANDROID_KEYSTORE_PASSWORD="$(security find-generic-password -a "$KEYCHAIN_ACCOUNT" -s "$KEYCHAIN_SERVICE" -w)"; then
  echo "sign-android: cannot read the store password from the login Keychain." >&2
  echo "sign-android: expected service '$KEYCHAIN_SERVICE', account '$KEYCHAIN_ACCOUNT'." >&2
  echo "sign-android: add the item with the command in release/README.md." >&2
  exit 1
fi

if [ -z "$ANDROID_KEYSTORE_PASSWORD" ]; then
  echo "sign-android: the Keychain item holds an empty value." >&2
  echo "sign-android: re-add the item with the command in release/README.md." >&2
  exit 1
fi

export ANDROID_KEYSTORE_PASSWORD
export ANDROID_KEY_PASSWORD="$ANDROID_KEYSTORE_PASSWORD"

# The version stamp must match release/version.json before the build.
( cd "$(dirname "$0")/.." && node scripts/stamp-version.mjs --check )

# Gradle does not rebuild the Rust library. Without this step a release can
# ship the libdaak_ffi.so of an earlier build.
"$(dirname "$0")/../apps/mobile/scripts/gen-android-ffi.sh"

cd "$(dirname "$0")/../apps/mobile/android"
./gradlew --no-daemon :app:assembleRelease --offline

# ABI splits emit three signed APKs. The user installs ONE of them. The two
# device APKs are small. The universal APK is the fallback for a user who does
# not know the device ABI.
for apk in "$PWD"/app/build/outputs/apk/release/daak-*-arm64-v8a.apk \
           "$PWD"/app/build/outputs/apk/release/daak-*-armeabi-v7a.apk \
           "$PWD"/app/build/outputs/apk/release/daak-*-universal.apk; do
  echo "APK: $apk"
  echo "APK size: $(stat -f '%z' "$apk") bytes"

  # The certificate digest is public. It is the same value the release README
  # prints, so a user can compare a downloaded APK against it.
  "$ANDROID_HOME/build-tools/35.0.0/apksigner" verify --print-certs "$apk"

  # The Android floor is 8.0, API 26 (plan Global Constraints). Stop when an APK
  # declares a lower one, because it would install on a version nobody tested.
  if ! "$ANDROID_HOME/build-tools/35.0.0/aapt" dump badging "$apk" | grep -q "^sdkVersion:'26'"; then
    echo "sign-android: $apk does not declare minSdk 26." >&2
    exit 1
  fi
done
