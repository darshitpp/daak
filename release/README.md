# Daak release runbook

This directory holds the public release material. It holds no secret.

For the user install steps for each target, see the `## Install` section in the
root `README.md`.

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

`apksigner` prints the digest in lowercase and with no colons, so the printed
value is `0d825cdc0069c9176bc9232f4be5a5266d51888f54c8fc2ff123c5b41f8f9df5`.
Both values are the same digest. Compare the printed value with the lowercase
value.

Build the APK:

    export JAVA_HOME="/path/to/jdk-17"
    export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
    export ANDROID_SDK_ROOT=$ANDROID_HOME
    cd apps/mobile/android && ./gradlew :app:assembleRelease --offline

ABI splits emit three signed APKs in
`apps/mobile/android/app/build/outputs/apk/release/`:

| APK | Use |
| --- | --- |
| `daak-0.1.0-arm64-v8a.apk` | A modern 64-bit phone |
| `daak-0.1.0-armeabi-v7a.apk` | An older 32-bit phone |
| `daak-0.1.0-universal.apk` | A user who does not know the device ABI. It holds both ABIs |

The two device APKs are the small download. The universal APK is the fallback.

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

## Release with one command

`scripts/release.sh <version>` runs the whole release. The version must equal
`release/version.json`.

First, bump `release/version.json`. Then run `node scripts/stamp-version.mjs`.
Then commit and run:

    ./scripts/release.sh 0.1.1

Stages 1 to 8 change only local files. They check the tools, the tree, and the
version stamp. They run the build gates and build and sign the APKs, the
`.dmg`, and the `.ipa`. They write the SHA-256 values to
`release/sha256-<version>.txt`.

Stages 9 to 12 publish. Each one asks `y/N` first. The script has no
`--yes` flag.

| Stage | What it does |
| --- | --- |
| 9 | Commits the hash file. Pushes `main` and the tag `v<version>`. |
| 10 | Uploads the 5 files to the GitHub Release. Publishes it. |
| 11 | Updates the cask in `darshitpp/homebrew-tap`. Runs `brew audit`. Pushes. |
| 12 | Fills the F-Droid recipe. Runs `fdroid lint` and `fdroid build`. Opens the merge request. |

Run `--from 9` to restart at the publish stages. Every stage reads the remote
state first, so a second run does not make a second tag, Release, or merge
request.

One-time setup:

- Log in: `gh auth login` and `glab auth login`.
- Install: `brew install gh glab` and `pipx install fdroidserver`.
- Create the empty repository `darshitpp/homebrew-tap` on GitHub.
- Keep the upload key and the Keychain item (see Signing above).

The templates `fdroid/dev.darshit.daak.yml` and `release/homebrew/daak.rb` keep
the literal text `0.1.1`, `versionCode: 22`, and `versionCode: 21`. The script
replaces those strings. Do not rename them.

What stays manual:

- Answer F-Droid reviewer comments in the merge request.
- After the first F-Droid release, an update is not automatic
  (`AutoUpdateMode: None`). Stage 12 stops and prints the filled recipe. Add the
  two new `Builds` entries to `metadata/dev.darshit.daak.yml` by hand.
- Run `fdroid checkupdates` to see that a new tag exists.
- Decide whether a Release is a pre-release.

F-Droid signs its own APK with its own key. A user of the GitHub APK cannot
update in place to the F-Droid app. The README says this.

The Linux build of the Rust library has a CI check (job `android-ffi` in
`.github/workflows/ci.yml`). Run it from the Actions tab before a release.
