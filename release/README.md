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

    export JAVA_HOME=<path to a JDK 17>
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

## Android signing on GitHub

`release.sh` does not build the APKs on this machine. A GitHub run
(`.github/workflows/release.yml`, started with `workflow_dispatch`) builds them
on Linux at the F-Droid build path. A second job signs them in the environment
`release`. `release.sh` downloads the signed APKs and checks them.

The build must match the F-Droid build byte for byte. Then the recipe can use
`binary:`, and F-Droid publishes the APK that this key signed.

| Item | Rule |
| --- | --- |
| Secrets | `ANDROID_KEYSTORE_BASE64` and `ANDROID_KEYSTORE_PASSWORD`. They live in the environment `release`, not in the repository |
| Reviewer | The owner approves each run in GitHub. "Prevent self-review" is off, because one person owns the repository |
| Branch rule | The environment accepts the branch `main` only |
| Sign job | It never checks out the repository. It runs only `apksigner` |
| Build job | It holds no secret. It builds only a full commit SHA that is on `main` |
| Same steps | The build steps in `fdroid/dev.darshit.daak.yml` and the job `android-unsigned` in `release.yml` must stay equal. If one changes, change the other |

Create the environment and the secrets one time. The password goes from the
Keychain through a pipe, so it never shows on the screen:

    cd ~/Projects/daak
    # 1. Check the password against the keystore. It prints nothing on success.
    keytool -list -keystore "$ANDROID_KEYSTORE_PATH" -alias daak \
      -storepass "$(security find-generic-password -a daak -s daak-android-upload -w)" >/dev/null && echo "password ok"

    # 2. The environment: you as reviewer, branch main only.
    uid="$(gh api user -q .id)"
    jq -n --argjson id "$uid" '{reviewers:[{type:"User",id:$id}],prevent_self_review:false,deployment_branch_policy:{protected_branches:false,custom_branch_policies:true}}' \
      | gh api -X PUT repos/darshitpp/daak/environments/release --input -
    gh api -X POST repos/darshitpp/daak/environments/release/deployment-branch-policies -f name=main -f type=branch

    # 3. The secrets, in the environment.
    base64 < "$ANDROID_KEYSTORE_PATH" | tr -d '\n' | gh secret set ANDROID_KEYSTORE_BASE64 --env release --repo darshitpp/daak
    security find-generic-password -a daak -s daak-android-upload -w | gh secret set ANDROID_KEYSTORE_PASSWORD --env release --repo darshitpp/daak

Then run `gh secret list --env release --repo darshitpp/daak`. It lists both
names.

If the key leaks, another party can sign updates of `dev.darshit.daak`. First,
delete both secrets. Then rotate the key with APK signature scheme v3 key
rotation, or publish a new package.

The F-Droid bot can build a tag before the release assets exist. The build then
fails with HTTP 404. Run the pipeline again after stage 10 publishes the
assets.

## Signing on this machine

This is the manual fallback. `release.sh` uses the GitHub run. The script
`scripts/sign-android.sh` reads the store password from the macOS
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

Keep an offline backup of the Android keystore and its passwords. The private
backup notes are in `release/LOCAL.md`. That file is not in Git.

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

Stages 1 to 4 and 6 to 8 change only local files. They check the tools, the
tree, and the version stamp. They run the build gates and write the SHA-256
values to `release/sha256-<version>.txt`. Stage 5 pushes `main` after it asks.

Stages 9 to 12 publish. Each one asks `y/N` first. The script has no
`--yes` flag.

| Stage | What it does |
| --- | --- |
| 5 | Pushes `main` (asks first). Starts the GitHub run. You approve the environment. Downloads and checks the 3 signed APKs. Builds the `.dmg` and the `.ipa`. |
| 9 | Commits the hash file. Pushes `main` and the tag `v<version>`. |
| 10 | Uploads the 5 files to the GitHub Release. Publishes it. |
| 11 | Updates the cask in `darshitpp/homebrew-tap`. Runs `brew audit`. Pushes. |
| 12 | Fills the F-Droid recipe. Runs `fdroid lint` and `fdroid build`. Opens the merge request. |

Run `--from 9` to restart at the publish stages. Every stage reads the remote
state first, so a second run does not make a second tag, Release, or merge
request.

One-time setup:

- Log in: `gh auth login` and `glab auth login`.
- Install: `brew install gh glab fdroidserver`.
- Create the empty repository `darshitpp/homebrew-tap` on GitHub.
- Keep the upload key and the Keychain item (see Signing above).
- Write the machine paths to `~/.config/daak/release.env`. The file is outside
  the repository and holds no password:

      export JAVA_HOME=<path to a JDK 17>
      export ANDROID_HOME=<path to the Android SDK>
      export ANDROID_KEYSTORE_PATH=<path to the upload keystore>

  `release.sh` loads this file for every stage. Set `DAAK_RELEASE_ENV` to use
  another path. A value already in the shell wins over the file.

The templates `fdroid/dev.darshit.daak.yml` and `release/homebrew/daak.rb` keep
the literal text `0.1.1`, `versionCode: 22`, and `versionCode: 21`. The script
replaces those strings. Do not rename them.

What stays manual:

- Answer F-Droid reviewer comments in the merge request.
- After the first F-Droid release, the F-Droid bot adds the new `Builds` entries
  (`AutoUpdateMode: Version`). It copies the last two entries and changes only
  `versionName`, `versionCode`, and `commit`. Do not put a version in any other
  field of the recipe. Stage 12 stops when `metadata/dev.darshit.daak.yml`
  exists upstream.
- The recipe has `binary:` for each build. The F-Droid bot copies it to new
  entries. The release assets must exist before the bot builds the tag.
- Run `fdroid checkupdates` to see that a new tag exists.
- Decide whether a Release is a pre-release.

F-Droid signs its own APK with its own key. A user of the GitHub APK cannot
update in place to the F-Droid app. The README says this.

The Linux build of the Rust library has a CI check (job `android-ffi` in
`.github/workflows/ci.yml`). Run it from the Actions tab before a release.
