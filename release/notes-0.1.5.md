This release adds folder transfers, a speed display, and a faster send. It also adds a Report an issue button with a local, in-memory log.

## Android

**New**
- Send and receive whole folders. A folder arrives as a folder, with the same tree. The thread shows one row for the folder, with Retry for each file.
- Photos and videos in a folder go to the Gallery. Other files stay together in a folder.
- A name that exists gets a `-1` or `-2` suffix.
- The transfer screen shows the speed and the time left.
- Settings has a Report an issue button. It copies the recent log to the clipboard and opens the GitHub new-issue page. The log stays in memory. The app writes no log to the disk.

**Changed**
- The receiver never writes into a file that it did not create. A send fails when a source file changes during the send.
- A send overlaps reading, encrypting, and writing. A transfer is faster when the disk or the CPU limits it. On a slow Wi-Fi link the network still limits the speed.

## iOS

**New**
- Folder transfers, the speed display, and Report an issue. These are the same as on Android. Photos and videos in a folder go to Photos.

**Fixed**
- The arrival banner plays the default sound.

## macOS

**New**
- Folder transfers, the speed display, and Report an issue. These are the same as on Android.
- Send with Daak is an entry in the Finder Services menu. Right-click a file or a folder in Finder, then choose Services, then Send with Daak. Daak opens with the files attached and asks for a device. A tap on a device sends at once. Cancel stops a send that is running.

**Fixed**
- The arrival banner plays the default sound.

## Update both devices

0.1.4 and 0.1.5 use the same protocol major version, so they still connect. Rebuilding a folder and the resume of missing chunks need 0.1.5 on both devices.

## Known limits

- The macOS app is not notarized. Run `xattr -dr com.apple.quarantine /Applications/Daak.app` once.
- The speed gain depends on the device. A measurement on a real network is not done yet.

**Full Changelog**: https://github.com/darshitpp/daak/compare/v0.1.4...v0.1.5
