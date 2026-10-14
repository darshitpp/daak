# Daak release verification matrix

This file records the release checks for version 0.1.3, build number 4.
The build ran on 2026-10-14 from commit d39b684. The tag `v0.1.3` is commit 5092cf4, which adds only the hash file.
The SHA-256 values are in `release/sha256-0.1.3.txt`.
The results for earlier versions are in the Git history of this file.

## Checks that ran on the build host

| Target | Artifact | Check | Result |
| --- | --- | --- | --- |
| Gates | the workspace | `cargo fmt --check` and `cargo clippy -D warnings` exit zero. `cargo test --workspace` passes 605 tests. `pnpm -r typecheck`, `pnpm -r test`, and `proto/codegen.sh` pass, and `proto/gen` is unchanged. | PASS. The 2 tests `a_stored_base_name_resolves_to_a_prefixed_name_and_self_profile_reports_it` and `the_stored_name_is_the_base_name_and_not_the_resolved_name` were skipped. They fail on this host, because it does not deliver the mDNS collision that they need. They fail the same way on the base commit |
| Android | each APK | The package is `dev.darshit.daak` and `versionName` is `0.1.3`. | PASS |
| Android | `daak-0.1.3-arm64-v8a.apk` | `versionCode` is `42`. | PASS |
| Android | `daak-0.1.3-armeabi-v7a.apk` | `versionCode` is `41`. | PASS |
| Android | `daak-0.1.3-universal.apk` | `versionCode` is `40`. | PASS |
| Android | each APK | The signer fingerprint is `0d825cdc0069c9176bc9232f4be5a5266d51888f54c8fc2ff123c5b41f8f9df5`. | PASS. All three APKs print it |
| Android | each APK | The SHA-256 values are in `release/sha256-0.1.3.txt`. | PASS |
| macOS | `Daak-0.1.3.dmg` | The build and the hash step of `release.sh` finished. | PASS. NOT checked again: `codesign`, `spctl`, and the launch |
| iOS | `Daak-0.1.3.ipa` | The build and the hash step of `release.sh` finished. | PASS. NOT checked again: the unsigned state and the contents |
| GitHub | the 5 Release assets | `v0.1.3` is public and is `Latest`. The notes list the changes for each OS. | PASS |

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
| F-Droid | The F-Droid CI build of the merge request makes the APK for each entry. | PASS. Pipeline 2947616774 printed `Successfully built dev.darshit.daak:41` and `:42` from commit 5092cf4 (0.1.3, R8 on) |
| F-Droid | CI on the merge request passes. | PASS. All 9 jobs of pipeline 2947616774 succeeded |
| F-Droid | The merge request is open. | PASS. https://gitlab.com/fdroid/fdroiddata/-/merge_requests/52240 |
| F-Droid | A maintainer merged the merge request. | PENDING. The maintainer asked for R8. 0.1.3 enables it |
| F-Droid | The app shows in the F-Droid client. | PENDING |
| Homebrew | `brew audit --cask --strict darshitpp/tap/daak` exits zero. | PASS. The script pushes the cask only after the audit |
| Homebrew | `brew upgrade --cask darshitpp/tap/daak` installs the new version. | PASS for 0.1.1 to 0.1.2 and for 0.1.2 to 0.1.3. `brew list --cask --versions daak` printed `daak 0.1.3`. The cask commit is `95a5361` |
