# Daak release verification matrix

This file records the release checks for version 0.1.0, build number 1.
The controller runs a check and writes the real value in the Result column.

## Checks that ran on the build host

| Target | Artifact | Check | Result |
| --- | --- | --- | --- |
| Android | `Daak-0.1.0.apk` | The package is `dev.darshit.daak`. | PASS |
| Android | `Daak-0.1.0.apk` | `versionName` is `0.1.0`. | PASS |
| Android | `Daak-0.1.0.apk` | `versionCode` is `1`. | PASS |
| Android | `Daak-0.1.0.apk` | The file holds four ABIs. | PASS |
| Android | `Daak-0.1.0.apk` | The Hermes bundle is present. | PASS |
| Android | `Daak-0.1.0.apk` | The signer fingerprint equals the public fingerprint `0D:82:5C:DC:00:69:C9:17:6B:C9:23:2F:4B:E5:A5:26:6D:51:88:8F:54:C8:FC:2F:F1:23:C5:B4:1F:8F:9D:F5`. | PASS |
| Android | `Daak-0.1.0.apk` | The SHA-256 is `4ac0ed2edf94050a9771a8cc07801d603267f3d20be1c4fda49601892d0ca81a`. | PASS |
| Android | `Daak-0.1.0.apk` | Discrepancy D-A8: the APK reports `minSdk` 24. The plan floor is 26. | OPEN |
| macOS | `Daak-0.1.0.dmg` | The archive printed `ARCHIVE SUCCEEDED`. | PASS |
| macOS | `Daak-0.1.0.dmg` | `codesign` reports valid on disk. | PASS |
| macOS | `Daak-0.1.0.dmg` | The app satisfies its Designated Requirement. | PASS |
| macOS | `Daak-0.1.0.dmg` | `spctl` rejects the app and the image. The origin is `Apple Development: darshit12@gmail.com (9VTBKNCJJ2)`. The app is not notarized, so this result is expected. | PASS |
| macOS | `Daak-0.1.0.dmg` | The SHA-256 is `b1719b22312b2cecfa2820a32657e346b81b1a82f85efc0032dc0c4863fadee8`. | PASS |
| iOS | `Daak-0.1.0.ipa` | The archive printed `ARCHIVE SUCCEEDED`. | PASS |
| iOS | `Daak-0.1.0.ipa` | The app holds no `PlugIns` directory. | PASS |
| iOS | `Daak-0.1.0.ipa` | The app holds no `.appex` file. | PASS |
| iOS | `Daak-0.1.0.ipa` | The app holds no `embedded.mobileprovision`. | PASS |
| iOS | `Daak-0.1.0.ipa` | The executable is `arm64`. | PASS |
| iOS | `Daak-0.1.0.ipa` | The app is not signed. | PASS |
| iOS | `Daak-0.1.0.ipa` | The SHA-256 is `149964d518f15e9b368c94f54e1a7d6c20d8469d0a2ae0d8df7f73f5149530c9`. | PASS |

## Checks that a human must run by hand

| Target | Check | Result |
| --- | --- | --- |
| Android | Install the `Daak-0.1.0.apk` on a device. Open the app. | NOT RUN |
| macOS | Mount the `Daak-0.1.0.dmg`. Launch the app past Gatekeeper. | NOT RUN |
| iOS | Sideload the `Daak-0.1.0.ipa` with a free Apple ID. Finish onboarding. | NOT RUN |

The iOS onboarding row is the last unproven link. The app holds no App Group
on the device file by design.
