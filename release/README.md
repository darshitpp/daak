# Daak release runbook

This directory holds the public release material. It holds no secret.

## Release matrix

Daak ships three targets from GitHub Releases on `darshitpp/daak`.

| Target | Artifact | Signing |
| --- | --- | --- |
| Android | `.apk` | Self-signed with the upload key |
| macOS | `.dmg` | Apple Development certificate. Not notarized |
| iOS | `.ipa` | Unsigned. The user sideloads it |

Windows and Linux are not released. No machine exists to build them.

## Android signing

Gradle signs the release APK with the upload key. Gradle reads the four values
from `apps/mobile/android/keystore.properties` when that file exists. Otherwise
Gradle reads the environment variables `ANDROID_KEYSTORE_PATH`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`.
When neither source is present, Gradle makes no release signing config and the
release build writes an unsigned APK.

Copy `apps/mobile/android/keystore.properties.example` to
`apps/mobile/android/keystore.properties` and fill in the two passwords. The
copy is gitignored. Never commit it.

| Field | Value |
| --- | --- |
| Key alias | `daak` |
| Certificate | `release/daak-signing-cert.pem` |
| SHA-256 fingerprint | `0D:82:5C:DC:00:69:C9:17:6B:C9:23:2F:4B:E5:A5:26:6D:51:88:8F:54:C8:FC:2F:F1:23:C5:B4:1F:8F:9D:F5` |

Build the APK:

    export JAVA_HOME="/path/to/jdk-17"
    export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
    export ANDROID_SDK_ROOT=$ANDROID_HOME
    cd apps/mobile/android && ./gradlew :app:assembleRelease --offline

The APK is `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`.

## Signing on this machine

The script `scripts/sign-android.sh` reads the store password from the macOS
login Keychain. Nobody types the password for a build. No password file exists
on disk. The script exports the four `ANDROID_KEY*` variables, runs the release
Gradle task, and prints the APK path, its size, and the signer certificate
digest. The digest is public.

Add the Keychain item one time. The command prompts for the password and does
not put it on the command line.

    security add-generic-password -a daak -s daak-android-upload -w

Then build and sign:

    ./scripts/sign-android.sh

The script exits non-zero with a clear message when the Keychain item is
missing. The key password equals the store password, so the script uses the one
Keychain value for both Gradle variables.

## Verify a download

The user compares the signer of the downloaded APK with the fingerprint above.

    $ANDROID_HOME/build-tools/35.0.0/apksigner verify --print-certs <apk>

The printed `SHA-256 digest` must equal the fingerprint in this file. A
different digest means a different key signed the APK. Stop and do not install
it.

## Key copies

Three copies of the Android key exist. No copy holds a password.

| Copy | Where |
| --- | --- |
| Working file | `/path/to/daak-upload.jks`, mode 600 |
| Replica | An offline secure note: the base64 of the `.jks` plus its SHA-256 |
| Passwords | an offline password store |

A lost Android keystore blocks every later update of the same package.

## macOS and iOS

The macOS `.dmg` is not notarized. The README tells the user to right-click
then Open, or to run `xattr -dr com.apple.quarantine`.

The iOS `.ipa` is unsigned. The user signs it with a free Apple ID, and that
profile lasts 7 days.
