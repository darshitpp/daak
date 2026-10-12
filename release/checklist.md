# Daak release verification matrix

This file records the release checks for version 0.1.1, build number 2.
The build ran on 2026-10-12 from commit e6cba23. The tag `v0.1.1` is commit 130550a, which adds only the hash file.
The values come from the files in the published Release, which match the local files.
The results for version 0.1.0 are in the Git history of this file.

## Checks that ran on the build host

| Target | Artifact | Check | Result |
| --- | --- | --- | --- |
| Android | each APK | The package is `dev.darshit.daak`. | PASS |
| Android | each APK | `versionName` is `0.1.1`. | PASS |
| Android | `daak-0.1.1-arm64-v8a.apk` | `versionCode` is `22`. | PASS |
| Android | `daak-0.1.1-armeabi-v7a.apk` | `versionCode` is `21`. | PASS |
| Android | `daak-0.1.1-universal.apk` | `versionCode` is `20`. | PASS |
| Android | `daak-0.1.1-arm64-v8a.apk` | The file holds the `arm64-v8a` ABI only. | PASS |
| Android | `daak-0.1.1-armeabi-v7a.apk` | The file holds the `armeabi-v7a` ABI only. | PASS |
| Android | `daak-0.1.1-universal.apk` | The file holds the `arm64-v8a` and `armeabi-v7a` ABIs only. | PASS |
| Android | each APK | `libdaak_ffi.so`, `libhermesvm.so`, and the Hermes bundle `assets/index.android.bundle` are present. | PASS |
| Android | each APK | `aapt` reports `sdkVersion:'26'`. | PASS |
| Android | each APK | The signer fingerprint equals the public fingerprint `0D:82:5C:DC:00:69:C9:17:6B:C9:23:2F:4B:E5:A5:26:6D:51:88:8F:54:C8:FC:2F:F1:23:C5:B4:1F:8F:9D:F5`. | PASS. All three APKs print `0d825cdc0069c9176bc9232f4be5a5266d51888f54c8fc2ff123c5b41f8f9df5` |
| Android | `daak-0.1.1-arm64-v8a.apk` | The SHA-256 is `c596981a74142357d776ebeafc485660186b1d9b59d9f989db0e85a7976a781c`. | PASS |
| Android | `daak-0.1.1-armeabi-v7a.apk` | The SHA-256 is `11d360321286c190260dab0ee78137b14c05d6af9302894bf16f03ceaa3b4ab0`. | PASS |
| Android | `daak-0.1.1-universal.apk` | The SHA-256 is `33133f511b4402467beac01098ef88514b77cbe1b0e5edc565f48c85ad3a5f3c`. | PASS |
| macOS | `Daak-0.1.1.dmg` | The archive printed `ARCHIVE SUCCEEDED`. | PASS |
| macOS | `Daak-0.1.1.dmg` | `codesign --verify --deep --strict` reports valid on disk. | PASS |
| macOS | `Daak-0.1.1.dmg` | The app satisfies its Designated Requirement. | PASS |
| macOS | `Daak-0.1.1.dmg` | `spctl` rejects the app and the image. The origin is the `Apple Development` certificate of team `J6NNRLDUG4`. The app is not notarized, so this result is expected. | PASS |
| macOS | `Daak-0.1.1.dmg` | The executable holds `x86_64` and `arm64`. The version is `0.1.1`. | PASS |
| macOS | `Daak-0.1.1.dmg` | The SHA-256 is `3895c9b4fea0c4cfeb0e92f96ec4dac899eb97fbca650f0982abeee103f340a4`. | PASS |
| macOS | `Daak-0.1.1.dmg` | The app reports `NSAllowsArbitraryLoads` as `false`. | PASS |
| macOS | `Daak-0.1.1.dmg` | The only App Group is `J6NNRLDUG4.group.dev.darshit.daak`. | PASS |
| iOS | `Daak-0.1.1.ipa` | The archive printed `ARCHIVE SUCCEEDED`. | PASS |
| iOS | `Daak-0.1.1.ipa` | The app holds no `PlugIns` directory and no `.appex` file. | PASS |
| iOS | `Daak-0.1.1.ipa` | The app holds no `embedded.mobileprovision`. | PASS |
| iOS | `Daak-0.1.1.ipa` | The executable is `arm64`. The version is `0.1.1`. | PASS |
| iOS | `Daak-0.1.1.ipa` | The app is not signed (`code object is not signed at all`). | PASS |
| iOS | `Daak-0.1.1.ipa` | The SHA-256 is `b946fc7bf7290cd2459a63da9f1f7227c4219ec03805c2d6042526bbc2dd4313`. | PASS |
| GitHub | the 5 Release assets | The SHA-256 digest that GitHub reports equals the local file. | PASS |

## Checks that a human must run by hand

| Target | Check | Result |
| --- | --- | --- |
| Android | Install `daak-0.1.1-arm64-v8a.apk` on a device. Open the app. | NOT RUN |
| macOS | Mount the `Daak-0.1.1.dmg`. Launch the app past Gatekeeper. | NOT RUN |
| iOS | Sideload the `Daak-0.1.1.ipa` with a free Apple ID. Finish onboarding. | NOT RUN |

The iOS onboarding row is the last unproven link. The app holds no App Group
on the device file by design.

## Store channels (added 2026-10-12)

| Channel | Check | Result |
| --- | --- | --- |
| F-Droid | `fdroid lint dev.darshit.daak` exits zero. | PASS. Local run, and the `fdroid lint` job of pipeline 2938070669 |
| F-Droid | The F-Droid CI build of the merge request makes the APK for each entry. | PASS. Pipeline 2938070669 printed `Successfully built dev.darshit.daak:21` and `:22` from commit 130550a |
| F-Droid | The merge request is open. | PASS. https://gitlab.com/fdroid/fdroiddata/-/merge_requests/52240 |
| F-Droid | CI on the merge request passes. | PASS. All 9 jobs of pipeline 2938070669 succeeded |
| F-Droid | A maintainer merged the merge request. | PENDING |
| F-Droid | The app shows in the F-Droid client. | PENDING |
| Homebrew | `brew audit --cask --strict darshitpp/tap/daak` exits zero. The script pushes the cask only after this audit passes. | PASS |
| Homebrew | `brew install --cask darshitpp/tap/daak` installs `Daak.app` 0.1.1. | PASS. `brew list --cask --versions daak` prints `daak 0.1.1`. The user ran the install on 2026-10-12 |
