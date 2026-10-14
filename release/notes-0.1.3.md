## Android

**New**
- Pair with a six digit code when a device has no camera (#2).
- Save received photos and videos to the Gallery, in `Pictures/Daak` and `Movies/Daak` (#3). Android 10 and later need no permission. Android 8 and 9 keep the old behavior.
- Review more than 3 staged files in one sheet (#4).

**Fixed**
- The thread screen no longer pushes the note field and the Send button off the screen when you share many files (#4).
- The release APK now uses R8. F-Droid asked for this (#6).

## iOS

**New**
- Pair with a six digit code when a device has no camera (#2).
- Save received photos and videos to the Photos app (#3). Daak asks for add-only access in onboarding and in Settings.
- Review more than 3 staged files in one sheet (#4).

**Fixed**
- The thread screen no longer pushes the note field and the Send button off the screen when you share many files (#4).
- The keyboard no longer covers the review sheet.

## macOS

**New**
- Pair with a six digit code (#2). The Mac can show the code or enter it.
- Review more than 3 staged files in one sheet (#4).

**Fixed**
- The thread screen no longer pushes the note field and the Send button off the screen when you share many files (#4).

## Known limits

- Photos and videos no longer go to the save folder you choose on iOS and Android.
- On iOS, a tap on a Photos item shows an alert. Apple documents no link to one asset.
- The macOS app is not notarized. Run `xattr -dr com.apple.quarantine /Applications/Daak.app` once.

**Full Changelog**: https://github.com/darshitpp/daak/compare/v0.1.2...v0.1.3
