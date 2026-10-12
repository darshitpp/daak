# Daak release verification matrix

This file records the release checks for version 0.1.2, build number 3.
The build ran on 2026-10-12 from commit c9e78cf. The tag `v0.1.2` is commit 50f407e, which adds only the hash file.
The SHA-256 values come from the published Release and equal the local files.
The results for earlier versions are in the Git history of this file.

## Checks that ran on the build host

| Target | Artifact | Check | Result |
| --- | --- | --- | --- |
| Android | each APK | The package is `dev.darshit.daak`, `versionName` is `0.1.2`, and `aapt` reports `sdkVersion:'26'`. | PASS |
| Android | `daak-0.1.2-arm64-v8a.apk` | `versionCode` is `32`. The file holds the `arm64-v8a` ABI only. | PASS |
| Android | `daak-0.1.2-armeabi-v7a.apk` | `versionCode` is `31`. The file holds the `armeabi-v7a` ABI only. | PASS |
| Android | `daak-0.1.2-universal.apk` | `versionCode` is `30`. The file holds the `arm64-v8a` and `armeabi-v7a` ABIs only. | PASS |
| Android | each APK | `libdaak_ffi.so` and the Hermes bundle `assets/index.android.bundle` are present. | PASS |
| Android | each APK | The signer fingerprint equals `0D:82:5C:DC:00:69:C9:17:6B:C9:23:2F:4B:E5:A5:26:6D:51:88:8F:54:C8:FC:2F:F1:23:C5:B4:1F:8F:9D:F5`. | PASS. All three APKs print `0d825cdc0069c9176bc9232f4be5a5266d51888f54c8fc2ff123c5b41f8f9df5` |
| Android | `daak-0.1.2-arm64-v8a.apk` | The SHA-256 is `1dc2f0cc4d17016fd1ef0e757e0c6bae9b9a7dfb38ea11d30b2ac8a00fa75fb1`. | PASS |
| Android | `daak-0.1.2-armeabi-v7a.apk` | The SHA-256 is `e1a6db660e80a8926ae3cfee2197ffcbb989fe5d07e1a4b671efe95dbdd21a14`. | PASS |
| Android | `daak-0.1.2-universal.apk` | The SHA-256 is `26dae66218a17e74eb64640d119a55ba8608e408050c35904280d2b11b8b43da`. | PASS |
| macOS | `Daak-0.1.2.dmg` | The archive printed `ARCHIVE SUCCEEDED`. `codesign --verify --deep --strict` reports valid on disk. The app satisfies its Designated Requirement. | PASS |
| macOS | `Daak-0.1.2.dmg` | The executable holds `x86_64` and `arm64`. The version is `0.1.2`. | PASS |
| macOS | `Daak-0.1.2.dmg` | The SHA-256 is `7cb4c46944b810b7590a921f5f20cc8fac11debed0ef084e229d24403ecf3278`. | PASS |
| iOS | `Daak-0.1.2.ipa` | The archive printed `ARCHIVE SUCCEEDED`. The app holds no `.appex` file and no `embedded.mobileprovision`. | PASS |
| iOS | `Daak-0.1.2.ipa` | The executable is `arm64`, the version is `0.1.2`, and the app is not signed. | PASS |
| iOS | `Daak-0.1.2.ipa` | The SHA-256 is `f8a01d975c4797120bcdf425870d163ea89e7739349aa4e5b8808bfc8e5d51cc`. | PASS |
| GitHub | the 5 Release assets | The SHA-256 digest that GitHub reports equals the local file. | PASS |

Not run again for 0.1.2: `spctl`, `NSAllowsArbitraryLoads`, and the App Group of the `.dmg`. The 0.1.1 results are in the Git history.

## Checks that a human must run by hand

| Target | Check | Result |
| --- | --- | --- |
| Android | Install `daak-0.1.2-arm64-v8a.apk` on a device. Open the app. | PASS for the onboarding screens and the pairing and messaging between the phone and the Mac, on 2026-10-12. The screenshots came from a signed release build of commit 86feecf. That commit holds the same app code as 0.1.2. The 0.1.2 APK itself was not installed. |
| macOS | Mount the `Daak-0.1.2.dmg`. Launch the app past Gatekeeper. | NOT RUN |
| iOS | Sideload the `Daak-0.1.2.ipa` with a free Apple ID. Finish onboarding. | NOT RUN |

## Store channels (added 2026-10-12)

| Channel | Check | Result |
| --- | --- | --- |
| F-Droid | `fdroid lint dev.darshit.daak` exits zero. | PASS. Local run, and the `fdroid lint` job of pipeline 2938070669 |
| F-Droid | The F-Droid CI build of the merge request makes the APK for each entry. | PASS for 0.1.1. Pipeline 2938070669 printed `Successfully built dev.darshit.daak:21` and `:22` from commit 130550a. The 0.1.2 entries (31 and 32, commit 50f407e) are PENDING |
| F-Droid | The merge request is open. | PASS. https://gitlab.com/fdroid/fdroiddata/-/merge_requests/52240 |
| F-Droid | CI on the merge request passes. | PASS for 0.1.1 (pipeline 2938070669). PENDING for 0.1.2 (pipeline 2938418287) |
| F-Droid | A maintainer merged the merge request. | PENDING |
| F-Droid | The app shows in the F-Droid client. | PENDING |
| Homebrew | `brew audit --cask --strict darshitpp/tap/daak` exits zero. The script pushes the cask only after this audit passes. | PASS |
| Homebrew | `brew install --cask darshitpp/tap/daak` installs `Daak.app`. | PASS for 0.1.1. `brew list --cask --versions daak` printed `daak 0.1.1`. For 0.1.2 only the audit ran. The install and `brew upgrade` have not run |
