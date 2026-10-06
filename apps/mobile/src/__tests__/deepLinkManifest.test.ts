import { readFileSync } from 'fs';
import { join } from 'path';

// A daak:// link reaches a device ONLY when the platform registers the scheme.
// apps/mobile/src/deeplink.ts parses both routes and its suite is green, but a
// parser with no registered scheme has no caller: Android resolved no activity
// for `am start -a android.intent.action.VIEW -d daak://pair?bundle=...` and
// returned "Activity not started, unable to resolve Intent". This pins the
// registration on both hosts so a pair or send link cannot go dead quietly.
const manifest = readFileSync(
  join(__dirname, '../../android/app/src/main/AndroidManifest.xml'),
  'utf8',
);
const iosPlist = readFileSync(join(__dirname, '../../ios/Daak/Info.plist'), 'utf8');
const macPlist = readFileSync(
  join(__dirname, '../../../desktop/macos/Daak-macOS/Info.plist'),
  'utf8',
);

function mainActivity(): string {
  const start = manifest.indexOf('android:name=".MainActivity"');
  expect(start).toBeGreaterThan(-1);
  const end = manifest.indexOf('</activity>', start);
  return manifest.slice(start, end);
}

describe('daak:// deep-link registration', () => {
  it('registers the scheme on the Android main activity', () => {
    // MainActivity is singleTask, so a link into a running app arrives on
    // onNewIntent and React Native's Linking module delivers it. The filter
    // needs BROWSABLE or nothing on the web or in a browser can open it either.
    const activity = mainActivity();
    expect(activity).toMatch(/android\.intent\.action\.VIEW/);
    expect(activity).toMatch(/android\.intent\.category\.BROWSABLE/);
    expect(activity).toMatch(/android\.intent\.category\.DEFAULT/);
    // scheme + host. Android matches BOTH data elements together, so the
    // scheme alone would silently swallow nothing and the host alone would
    // claim every host under the scheme.
    expect(activity).toMatch(/android:scheme="daak"/);
    expect(activity).toMatch(/android:host="(send|pair)"/);
  });

  it('registers the same scheme on iOS and macOS', () => {
    for (const plist of [iosPlist, macPlist]) {
      expect(plist).toContain('<key>CFBundleURLSchemes</key>');
      expect(plist).toMatch(/<string>daak<\/string>/);
    }
  });
});
