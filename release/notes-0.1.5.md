This release adds folder transfers, a speed display, and a faster send. It also adds a Report an issue button with a local, in-memory log.

## Android

**New**
- Send and receive whole folders. A folder arrives as a folder.
- The transfer screen shows the speed and the time left.
- Settings has a Report an issue button. It copies the recent log to the clipboard and opens the GitHub new-issue page. The log stays in memory. The app writes no log to the disk.

**Changed**
- A send overlaps reading, encrypting, and writing. A transfer is faster when the disk or the CPU limits it. On a slow Wi-Fi link the network still limits the speed.

## iOS

**New**
- Folder transfers, the speed display, and Report an issue. These are the same as on Android.

**Fixed**
- The arrival banner plays the default sound.

## macOS

**New**
- Folder transfers, the speed display, and Report an issue. These are the same as on Android.
- Send with Daak is an entry in the Finder Services menu.

**Fixed**
- The arrival banner plays the default sound.

## Known limits

- The macOS app is not notarized. Run `xattr -dr com.apple.quarantine /Applications/Daak.app` once.
- The speed gain depends on the device. A measurement on a real network is not done yet.

**Full Changelog**: https://github.com/darshitpp/daak/compare/v0.1.4...v0.1.5
