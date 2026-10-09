# Daak release verification matrix

This file records the release checks for version 0.1.0, build number 1, built from commit f9b904d on 2026-10-09.
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
| Android | `daak-0.1.0-arm64-v8a.apk` | The SHA-256 is `543ace35fd649990991a0bf5ce825a81bdffe93d3afc1d6151b4dbc138c1b4f1`. | PASS |
| Android | `daak-0.1.0-armeabi-v7a.apk` | The SHA-256 is `d5ad310946eba62339ee63e71907fbd82ca8573ba1d814091e9d901266b8127e`. | PASS |
| Android | `daak-0.1.0-universal.apk` | The SHA-256 is `5c3302ab95ea73cfe8fbbe567914b9b9afe25df5b4f32923732909892034a155`. | PASS |
| Android | each APK | Discrepancy D-A8 is closed. `aapt` reports `sdkVersion:'26'`, and `sign-android.sh` stops when an APK declares less. | PASS |
| macOS | `Daak-0.1.0.dmg` | The archive printed `ARCHIVE SUCCEEDED`. | PASS |
| macOS | `Daak-0.1.0.dmg` | `codesign` reports valid on disk. | PASS |
| macOS | `Daak-0.1.0.dmg` | The app satisfies its Designated Requirement. | PASS |
| macOS | `Daak-0.1.0.dmg` | `spctl` rejects the app and the image. The origin is `Apple Development: darshit12@gmail.com (9VTBKNCJJ2)`. The app is not notarized, so this result is expected. | PASS |
| macOS | `Daak-0.1.0.dmg` | The SHA-256 is `124a1eb89b97d786c4dc8dbc4014b9d8fb067aa49743356f51ed084e9f8ac156`. | PASS |
| iOS | `Daak-0.1.0.ipa` | The archive printed `ARCHIVE SUCCEEDED`. | PASS |
| iOS | `Daak-0.1.0.ipa` | The app holds no `PlugIns` directory. | PASS |
| iOS | `Daak-0.1.0.ipa` | The app holds no `.appex` file. | PASS |
| iOS | `Daak-0.1.0.ipa` | The app holds no `embedded.mobileprovision`. | PASS |
| iOS | `Daak-0.1.0.ipa` | The executable is `arm64`. | PASS |
| iOS | `Daak-0.1.0.ipa` | The app is not signed. | PASS |
| iOS | `Daak-0.1.0.ipa` | The SHA-256 is `5762e212e6244dd99ba69c49229dcdc56136f0cc56526f08517bc33312cd210a`. | PASS |

## Checks that a human must run by hand

| Target | Check | Result |
| --- | --- | --- |
| Android | Install `daak-0.1.0-arm64-v8a.apk` on a device. Open the app. | NOT RUN |
| macOS | Mount the `Daak-0.1.0.dmg`. Launch the app past Gatekeeper. | NOT RUN |
| iOS | Sideload the `Daak-0.1.0.ipa` with a free Apple ID. Finish onboarding. | NOT RUN |

The iOS onboarding row is the last unproven link. The app holds no App Group
on the device file by design.
