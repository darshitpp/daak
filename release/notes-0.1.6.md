This release makes a send start sooner when a device comes back. It also adds photo batches on the phone and fixes several screens.

## Android

**New**
- Add photos sends a batch of photos and videos. On Android 13 and later, the system photo picker opens. On Android 11 and 12, the document picker opens.
- A batch shows one row in the thread. You can cancel it as a whole.
- The report-an-issue text includes the app version, the device model, the OS version, and the number of paired devices. It does not include names, ids, or addresses.

**Changed**
- A send waits for a device that is offline. It retries about every 2 s at first and about every 30 s later. It stops after 100 attempts, about 35 minutes.
- A send starts at once when the device comes back. Before, it waited for the end of the retry delay.
- A cancel of a waiting or failed send is final. The row has no Retry button.
- A staged folder has a name that opens a review sheet and a separate × that removes it. Before, a tap on the name removed the folder.

**Fixed**
- The send notification keeps its state and does not come back after you close it.
- The app checks the free space before it stages a large batch. It stops the send with a clear message when the space is too small.

## iOS

**New**
- Add photos, the batch row, and the longer report-an-issue text. These are the same as on Android.

**Fixed**
- Notifications from one conversation group together.

## macOS

**Changed**
- Faster send start, the final cancel, and the folder chip. These are the same as on Android.

## All platforms

**Fixed**
- The "A device you paired isn't showing" screen shows its tips open. A tip list opens and closes with an arrow.
- When the check finds every paired device, the screen says "Your paired devices are showing". Before, a tap did nothing.

## Update both devices

0.1.5 and 0.1.6 use the same protocol major version, so they still connect.

## Known limits

- The macOS app is not notarized. Run `xattr -dr com.apple.quarantine /Applications/Daak.app` once.
- The folder review sheet shows the file count and size. It does not list the files.
- On iOS, the report text shows the device type (iPhone or iPad), not the model.

**Full Changelog**: https://github.com/darshitpp/daak/compare/v0.1.5...v0.1.6
