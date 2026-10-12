# Daak release verification matrix

This file records the release checks for version 0.1.0, build number 1, built from commit 895378d on 2026-10-11.
The controller runs a check and writes the real value in the Result column.

## Checks that ran on the build host

| Target | Artifact | Check | Result |
| --- | --- | --- | --- |
| Android | `daak-0.1.0-arm64-v8a.apk` | The package is `dev.darshit.daak`. | PASS |
| Android | `daak-0.1.0-arm64-v8a.apk` | `versionName` is `0.1.0`. | PASS |
| Android | `daak-0.1.0-arm64-v8a.apk` | `versionCode` is `1`. | PASS |
| Android | `daak-0.1.0-arm64-v8a.apk` | The file holds the `arm64-v8a` ABI only. | PASS |
| Android | `daak-0.1.0-armeabi-v7a.apk` | The file holds the `armeabi-v7a` ABI only. | PASS |
| Android | `daak-0.1.0-universal.apk` | The file holds the `arm64-v8a` and `armeabi-v7a` ABIs only. | PASS |
| Android | each APK | The Hermes bundle is present. | PASS |
| Android | each APK | The signer fingerprint equals the public fingerprint `0D:82:5C:DC:00:69:C9:17:6B:C9:23:2F:4B:E5:A5:26:6D:51:88:8F:54:C8:FC:2F:F1:23:C5:B4:1F:8F:9D:F5`. | PASS. All three APKs print `0d825cdc0069c9176bc9232f4be5a5266d51888f54c8fc2ff123c5b41f8f9df5` |
| Android | `daak-0.1.0-arm64-v8a.apk` | The SHA-256 is `aa03bbeafaf56947e25cfce7873c2cc5b84039637e4f6a93ccf149e785e132c0`. | PASS |
| Android | `daak-0.1.0-armeabi-v7a.apk` | The SHA-256 is `6764e582184f8c9cd9046f824963d4fa856d978f011063cf8c7e73635e259f47`. | PASS |
| Android | `daak-0.1.0-universal.apk` | The SHA-256 is `8c89e4b7d8b79fa780cdc75e5a33c75f103933e12c32a479d826d9584aaa1467`. | PASS |
| Android | each APK | Discrepancy D-A8 is closed. `aapt` reports `sdkVersion:'26'`, and `sign-android.sh` stops when an APK declares less. | PASS |
| macOS | `Daak-0.1.0.dmg` | The archive printed `ARCHIVE SUCCEEDED`. | PASS |
| macOS | `Daak-0.1.0.dmg` | `codesign` reports valid on disk. | PASS |
| macOS | `Daak-0.1.0.dmg` | The app satisfies its Designated Requirement. | PASS |
| macOS | `Daak-0.1.0.dmg` | `spctl` rejects the app and the image. The origin is the `Apple Development` certificate of team `J6NNRLDUG4`. The app is not notarized, so this result is expected. | PASS |
| macOS | `Daak-0.1.0.dmg` | The SHA-256 is `b0c06497905baea09453ddd3147c270e0a5e2c09fe24a218675b033a846cdfa7`. | PASS |
| macOS | `Daak-0.1.0.dmg` | The app reports `NSAllowsArbitraryLoads` as `0`. | PASS |
| macOS | `Daak-0.1.0.dmg` | The only App Group is `J6NNRLDUG4.group.dev.darshit.daak`. | PASS |
| iOS | `Daak-0.1.0.ipa` | The archive printed `ARCHIVE SUCCEEDED`. | PASS |
| iOS | `Daak-0.1.0.ipa` | The app holds no `PlugIns` directory. | PASS |
| iOS | `Daak-0.1.0.ipa` | The app holds no `.appex` file. | PASS |
| iOS | `Daak-0.1.0.ipa` | The app holds no `embedded.mobileprovision`. | PASS |
| iOS | `Daak-0.1.0.ipa` | The executable is `arm64`. | PASS |
| iOS | `Daak-0.1.0.ipa` | The app is not signed. | PASS |
| iOS | `Daak-0.1.0.ipa` | The SHA-256 is `b199723a5ab5454bc2fc479e038c664e4fa4ae37f4ade20f0f06e31079eb5375`. | PASS |

## Checks that a human must run by hand

| Target | Check | Result |
| --- | --- | --- |
| Android | Install `daak-0.1.0-arm64-v8a.apk` on a device. Open the app. | NOT RUN |
| macOS | Mount the `Daak-0.1.0.dmg`. Launch the app past Gatekeeper. | NOT RUN |
| iOS | Sideload the `Daak-0.1.0.ipa` with a free Apple ID. Finish onboarding. | NOT RUN |

The iOS onboarding row is the last unproven link. The app holds no App Group
on the device file by design.

## Store channels (added 2026-10-12)

| Channel | Check | Result |
| --- | --- | --- |
| F-Droid | `fdroid lint dev.darshit.daak` exits zero. | PENDING |
| F-Droid | The F-Droid CI build of the merge request makes the APK for each entry. | PENDING |
| F-Droid | The merge request is open. | PASS. https://gitlab.com/fdroid/fdroiddata/-/merge_requests/52240 |
| F-Droid | CI on the merge request passes. | PENDING |
| F-Droid | A maintainer merged the merge request. | PENDING |
| F-Droid | The app shows in the F-Droid client. | PENDING |
| Homebrew | `brew audit --cask --strict darshitpp/tap/daak` exits zero. The script pushes the cask only after this audit passes. | PASS |
| Homebrew | `brew install --cask darshitpp/tap/daak` installs `Daak.app` 0.1.1. | PASS. `brew list --cask --versions daak` prints `daak 0.1.1`. The user ran the install on 2026-10-12 |
