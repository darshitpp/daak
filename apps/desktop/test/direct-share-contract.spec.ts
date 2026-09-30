import { describe, expect, it } from 'vitest';
import { parseDirectShareRoute } from '../src/routes';
// The REAL mobile parser, imported across the package boundary on purpose.
// apps/mobile/src/deeplink.ts is shipped, committed code that already parses
// this link, and apps/mobile/ios/Daak/Info.plist:28-38 already registers the
// `daak` scheme for it. If the two parsers drift, a link minted by one app is
// dead in the other -- and nothing else in the repo would say so, because the
// desktop suite only ever loaded the desktop parser.
import { parseDeepLink } from '../../mobile/src/deeplink';

const ID = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';

// ONE corpus, both parsers, one answer. Every case here is a SEND link, which
// is the only route the two apps share; pair/ is mobile-only and is pinned in a
// later block rather than forced to agree.
const SEND_LINKS = [
  `daak://send?deviceId=${ID}`,
  `DAAK://send?deviceId=${ID}`,
  `daak://SEND?deviceId=${ID}`,
  `daak://send?deviceId=${ID}&text=hello`,
  `daak://send/?deviceId=${ID}`,
];

const NOT_SEND = [
  'https://send?deviceId=abc',
  'daak://open?deviceId=abc',
  'daak://send',
  'daak://send?deviceId=',
  'daak://send?device=',
  'not a url',
  '',
  'file:///etc/passwd?deviceId=abc',
];

// The mobile parser is TOTAL: any input returns a DeepLink and never throws,
// with kind 'none' standing for 'not a route I can use'. The desktop parser is
// nullable. Normalising both to 'the device id or null' is what lets one corpus
// pin both without forcing either parser's internal error handling to change.
function mobileDeviceId(url: string): string | null {
  const link = parseDeepLink(url);
  return link.kind === 'send' ? link.deviceId : null;
}

function desktopDeviceId(url: string): string | null {
  return parseDirectShareRoute(url)?.deviceId ?? null;
}

describe('desktop and mobile agree on the daak:// send-route contract', () => {
  it.each(SEND_LINKS)('both parsers accept %s', (url) => {
    expect(desktopDeviceId(url)).toBe(mobileDeviceId(url));
    // ...and the agreement is not two nulls. A parser that rejected the whole
    // corpus would pass the line above; this pins that the id really came out.
    expect(desktopDeviceId(url)).toBe(ID);
  });

  it.each(NOT_SEND)('both parsers reject %s', (url) => {
    expect(desktopDeviceId(url)).toBeNull();
    expect(mobileDeviceId(url)).toBeNull();
  });

  // The specific disagreement that made this a blocker: the plan said
  // `device`, shipped mobile says `deviceId`, and NO url was accepted by both.
  it('accepts deviceId, the parameter mobile actually reads', () => {
    expect(desktopDeviceId(`daak://send?deviceId=${ID}`)).toBe(ID);
  });

  it('rejects the old device parameter, which mobile never read', () => {
    expect(desktopDeviceId(`daak://send?device=${ID}`)).toBeNull();
    expect(mobileDeviceId(`daak://send?device=${ID}`)).toBeNull();
  });

  // Where the two MUST differ, pinned so nobody 'fixes' it into agreement by
  // adding a pair route to desktop. pair/ is mobile's own route, and desktop
  // has no pairing-by-bundle flow to route into.
  it('leaves the mobile-only pair route to mobile', () => {
    expect(mobileDeviceId('daak://pair?bundle=abc')).toBeNull();
    expect(parseDeepLink('daak://pair?bundle=abc')).toEqual({ kind: 'pair', bundle: 'abc' });
    expect(desktopDeviceId('daak://pair?bundle=abc')).toBeNull();
  });

  // Two REAL, already-reviewed divergences. Neither is reachable from a link the
  // engine or the native Share menu mints (RNDirectShare.mm builds the URL from
  // an id it was handed, so it has no userinfo and no repeated key), and desktop
  // is the STRICTER of the two in both cases. Pinned explicitly so a future
  // 'make the parsers agree' pass reads these numbers instead of guessing.
  it('takes userinfo: desktop accepts, mobile rejects', () => {
    const url = `daak://user:pass@send?deviceId=${ID}`;
    expect(desktopDeviceId(url)).toBe(ID);
    expect(mobileDeviceId(url)).toBeNull();
  });

  it('takes a repeated deviceId: desktop rejects, mobile uses the first', () => {
    const url = `daak://send?deviceId=${ID}&deviceId=${ID}`;
    expect(desktopDeviceId(url)).toBeNull();
    expect(mobileDeviceId(url)).toBe(ID);
  });
});
