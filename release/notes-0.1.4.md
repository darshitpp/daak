This release changes how the Android APK is built. The app itself does not change from 0.1.3.

## Android

**Changed**
- The build is now reproducible. GitHub builds and signs the APKs on Linux, and F-Droid can build the same APK from the source. When F-Droid publishes the app, a user can update between GitHub and F-Droid with no reinstall. The upload key is the same as before.

**Fixed**
- The APK no longer holds the IP address of the machine that built it. Earlier releases carried it in the app resources. A release build has no use for it.

## iOS

No change from 0.1.3.

## macOS

No change from 0.1.3.

## Known limits

- The macOS app is not notarized. Run `xattr -dr com.apple.quarantine /Applications/Daak.app` once.
- The F-Droid app is not published yet. The merge request is open.

**Full Changelog**: https://github.com/darshitpp/daak/compare/v0.1.3...v0.1.4
