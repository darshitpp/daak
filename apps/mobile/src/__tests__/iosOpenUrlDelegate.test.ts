import { readFileSync } from 'fs';
import { join } from 'path';

// A daak:// link reaches JS only through UIKit calling the AppDelegate. iOS
// THROWS on the process when the delegate does not answer, and the throw is not
// a link failure the app can survive:
//
//   *** Terminating app due to uncaught exception 'NSInternalInconsistencyException',
//   reason: 'Application has LSSupportsOpeningDocumentsInPlace key, but doesn't
//   implement application:openURL:options: on delegate <AppDelegate: 0x...>'
//
// Info.plist carries LSSupportsOpeningDocumentsInPlace because the share
// extension and the document picker need it. That single key is what turns a
// missing handler from a silent no-op into a hard crash, so the registration
// the parser suite and the manifest suite both pin is worthless without it.
// Every daak://pair link killed the app instead of pairing, which left the
// send screen refusing at "peer is not paired" with no pairing ever created.
//
// Source-level pin, same discipline as backgroundExec.test.ts and
// notifyManifest.test.ts: there is no iOS unit-test target, and the crash is
// only observable by tapping a real link on a real device.
const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');

const delegate = read('../../ios/Daak/AppDelegate.mm');
const plist = read('../../ios/Daak/Info.plist');

// The comment above the handler must SAY it forwards to RCTLinkingManager, so
// an unstripped grep would pass on the prose alone. Stripping first is what
// makes the assertion about the code.
const code = (s: string) =>
  s
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');

describe('iOS AppDelegate URL handling', () => {
  it('implements the openURL delegate method UIKit calls for daak:// links', () => {
    const src = code(delegate);
    expect(src).toMatch(/application:\(UIApplication \*\)application\s*openURL:/);
  });

  // RCTLinkingManager is what stores the cold-launch initialURL and posts the
  // `url` event. A handler that answers YES without forwarding reaches no JS
  // code, so the link opens the app and then does nothing -- the same silence
  // this file exists to remove, one layer down.
  it('forwards the URL to RCTLinkingManager', () => {
    const src = code(delegate);
    const start = src.indexOf('openURL:(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n}', start);
    expect(end).toBeGreaterThan(start);
    const handler = src.slice(start, end);
    expect(handler).toMatch(/RCTLinkingManager/);
  });

  // The reason this is a crash rather than a dead button. If this key is ever
  // removed, the handler becomes optional and the suite above stops being the
  // load-bearing pin it is today -- so the key and the handler must agree.
  it('keeps the LSSupportsOpeningDocumentsInPlace key that makes the handler mandatory', () => {
    expect(plist).toContain('<key>LSSupportsOpeningDocumentsInPlace</key>');
  });

  it('imports RCTLinkingManager', () => {
    expect(code(delegate)).toMatch(/#import\s+<React\/RCTLinkingManager\.h>/);
  });
});
