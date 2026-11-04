# Daak release verification matrix

This file records the release checks for version 0.1.5, build number 6.
The Android APKs came from a GitHub Actions run on commit 2b45c8f, built on Linux and signed in the environment `release`. The tag `v0.1.5` is commit 3b49bac, which adds only the hash file.
The SHA-256 values are in `release/sha256-0.1.5.txt`.
The release checks for 0.1.5 were run on 2026-11-05 on the published assets. The "Checks that a human must run by hand" section still lists results for earlier versions.
The results for earlier versions are in the Git history of this file.

## Checks that ran on the build host

| Target | Artifact | Check | Result |
| --- | --- | --- | --- |
| Gates | the workspace | The gates ran on the pull request #19 (commit `1847fb1` on `main`). `cargo fmt --check` and `cargo clippy -D warnings` exit zero. `cargo test --workspace` passes 72 test targets. `pnpm -r typecheck` and `pnpm -r test` pass. | PASS for those. NOT run for the release: stage 4 of `release.sh` was skipped (`--from 5`), so `proto/codegen.sh` did not run. The release commits add only the version stamp, the notes, the changelogs, and the hash file |
| Gates | `display_name_persist` | The 2 tests `a_stored_base_name_resolves_to_a_prefixed_name_and_self_profile_reports_it` and `the_stored_name_is_the_base_name_and_not_the_resolved_name` fail with "the squatter did not force a collision". | FAIL on this host, also from the maintainer terminal. They fail the same way on the base commit `2c40672`, so the release does not cause them. They need the engine to see the mDNS announcement of a second advertiser on the same host. The cause is not found |
| Android | each APK | The package is `dev.darshit.daak` and `versionName` is `0.1.5`. | PASS. Checked with `aapt2` on the downloaded Release assets |
| Android | `daak-0.1.5-arm64-v8a.apk` | `versionCode` is `62`. | PASS |
| Android | `daak-0.1.5-armeabi-v7a.apk` | `versionCode` is `61`. | PASS |
| Android | `daak-0.1.5-universal.apk` | `versionCode` is `60`. | PASS |
| Android | each APK | The signer fingerprint is `0d825cdc0069c9176bc9232f4be5a5266d51888f54c8fc2ff123c5b41f8f9df5`. | PASS. `apksigner verify` prints it for all three APKs |
| Android | each APK | The SHA-256 values are in `release/sha256-0.1.5.txt`. | PASS. The values of the downloaded Release assets equal the file |
| macOS | `Daak-0.1.5.dmg` | `CFBundleShortVersionString` is `0.1.5` and `CFBundleVersion` is `6`. The binary has `x86_64` and `arm64` code. | PASS |
| macOS | `Daak-0.1.5.dmg` | `codesign --verify --deep --strict` passes. The team id is `J6NNRLDUG4`. | PASS. `spctl` rejects the app as expected, because it is not notarized. NOT checked: the launch, the Gatekeeper prompt, onboarding, and pairing |
| iOS | `Daak-0.1.5.ipa` | The bundle id is `dev.darshit.daak`, the version is `0.1.5`, and the build is `6`. | PASS |
| iOS | `Daak-0.1.5.ipa` | The package is unsigned. It has no `_CodeSignature` and no `embedded.mobileprovision`. | PASS |
| GitHub | the 5 Release assets | `v0.1.5` is public and is the latest Release. The notes list the changes for each OS. | PASS. The 3 APKs, the `.dmg`, and the `.ipa` are attached |

## Checks that a human must run by hand

| Target | Check | Result |
| --- | --- | --- |
| Android | R8 release build, `arm64-v8a`: the engine starts on an emulator, and a file transfer works between real devices. | PASS, on 2026-10-14. The build came from the R8 change of #7 and used a test key. The 0.1.3 APK itself was not installed. Not run: code pairing, Direct Share, `armeabi-v7a`, and the universal APK with R8 |
| Android and iOS | Save a received photo or video to the Gallery or Photos (#9). | PASS on a real iPhone and an Android phone. The maintainer ran it on the build of the pull request, on 2026-10-14 |
| Android and macOS | Pair with a six digit code (#5). | PASS between a Mac host and an Android joiner, on the build of the pull request |
| macOS | Install `Daak-0.1.3` and launch the app. | PASS for the launch, on 2026-10-14. `brew upgrade --cask` installed it from the GitHub Release (Homebrew checks the SHA-256). The app has version 0.1.3 and `x86_64` and `arm64` code. `codesign --verify --deep --strict` passes. `spctl` rejects the app as expected, because it is not notarized. The app was still running 10 s after the start and left no new crash report. NOT covered: the Gatekeeper prompt, onboarding, pairing, and the window (the accessibility query returned no window) |
| iOS | Sideload the `Daak-0.1.3.ipa` with a free Apple ID. Finish onboarding. | NOT RUN |

## Store channels

| Channel | Check | Result |
| --- | --- | --- |
| F-Droid | The F-Droid bot adds the build entries for 0.1.5 (`versionCode` 61 and 62). | PENDING. On 2026-11-05 the upstream recipe still has `CurrentVersion: 0.1.4`. The recipe has `AutoUpdateMode: Version`, so the bot adds the entries. The release assets that `binary:` compares exist. NOT run: `fdroid checkupdates` |
| Homebrew | The cask `darshitpp/homebrew-tap` has version `0.1.5` and the SHA-256 of the `.dmg`. | PASS. The cask commit is `5309a93`. NOT run: `brew upgrade --cask darshitpp/tap/daak` to 0.1.5 |
| F-Droid | The F-Droid CI build of the merge request makes the APK for each entry. | PASS. Pipeline 2951570539 built `dev.darshit.daak:51` and `:52` from commit 53c4939 (0.1.4) |
| F-Droid | CI on the merge request passes. | PASS. All 9 jobs of pipeline 2951668838 succeeded, including `fdroid rewritemeta`, `fdroid lint`, and `fdroid build` |
| F-Droid | `fdroid build` with `binary:` passes, and the signer is allowed. | PASS. The log prints "compared built binary to supplied reference binary successfully" and "supplied reference binary has allowed signer" for both entries. The signer is `0d825cdc0069c9176bc9232f4be5a5266d51888f54c8fc2ff123c5b41f8f9df5` |
| F-Droid | A maintainer merged the merge request. | PASS. https://gitlab.com/fdroid/fdroiddata/-/merge_requests/52240 merged on 2026-10-19 after the category changed to `File Transfer` |
| F-Droid | The app shows in the F-Droid client. | PASS. https://f-droid.org/packages/dev.darshit.daak/ is live (checked 2026-10-23). NOT run: an install from the F-Droid client |
| Homebrew | `brew audit --cask --strict darshitpp/tap/daak` exits zero. | PASS. The script pushes the cask only after the audit |
| Homebrew | `brew upgrade --cask darshitpp/tap/daak` installs the new version. | PASS for 0.1.1 to 0.1.2 and for 0.1.2 to 0.1.3. `brew list --cask --versions daak` printed `daak 0.1.3`. The cask commit is `95a5361`. For 0.1.4 the cask commit is `3ab177e`. NOT run: `brew upgrade` to 0.1.4 |
