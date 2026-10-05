import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDirectShareRoute } from '../src/routes';

// The deep link the macOS Share menu builds and the .desktop Actions build:
// daak://send?deviceId=<hex id>. Everything else -- another scheme, another host,
// a missing id -- must be null, because the caller turns a non-null result into
// a send to a specific device. A permissive parser here is a send to whatever
// the string happened to contain.
describe('parseDirectShareRoute', () => {
  it('extracts the target device from a direct-share URL', () => {
    expect(parseDirectShareRoute('daak://send?deviceId=abc123')).toEqual({ deviceId: 'abc123' });
  });

  it('rejects other schemes, hosts, and missing device ids', () => {
    expect(parseDirectShareRoute('https://send?deviceId=abc')).toBeNull();
    expect(parseDirectShareRoute('daak://open?deviceId=abc')).toBeNull();
    expect(parseDirectShareRoute('daak://send')).toBeNull();
    expect(parseDirectShareRoute('not a url')).toBeNull();
  });

  it('accepts a real 32-hex device id', () => {
    const id = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
    expect(parseDirectShareRoute(`daak://send?deviceId=${id}`)).toEqual({ deviceId: id });
  });

  // ---- rejections beyond the plan's four ----

  it('rejects an empty, valueless or misnamed device parameter', () => {
    expect(parseDirectShareRoute('daak://send?deviceId=')).toBeNull();
    expect(parseDirectShareRoute('daak://send?device')).toBeNull();
    expect(parseDirectShareRoute('daak://send?DeviceId=abc')).toBeNull();
    expect(parseDirectShareRoute('daak://send?peerId=abc')).toBeNull();
  });

  it('rejects a repeated device parameter instead of silently taking the first', () => {
    expect(parseDirectShareRoute('daak://send?deviceId=aaa&deviceId=bbb')).toBeNull();
  });

  it('rejects non-URL garbage, including the empty string and a file URL', () => {
    expect(parseDirectShareRoute('')).toBeNull();
    expect(parseDirectShareRoute('   ')).toBeNull();
    expect(parseDirectShareRoute('file:///etc/passwd?deviceId=abc')).toBeNull();
    expect(parseDirectShareRoute('daak:/send?deviceId=abc')).toBeNull();
    expect(parseDirectShareRoute('daak://')).toBeNull();
  });

  // A port on a LAN deep link is not a thing daak ever emits; accepting it
  // would mean shipping a route the engine cannot act on.
  it('rejects a URL carrying a port', () => {
    expect(parseDirectShareRoute('daak://send:1234?deviceId=abc')).toBeNull();
  });

  it('rejects a host that merely starts with send', () => {
    expect(parseDirectShareRoute('daak://send.send?deviceId=abc')).toBeNull();
    expect(parseDirectShareRoute('daak://sender?deviceId=abc')).toBeNull();
  });

  // ---- deliberate acceptances, pinned so a future edit is a conscious one ----

  // URL already lowercases the scheme and apps/mobile/src/deeplink.ts compares
  // a lowercased scheme too, so DAAK:// is the same route there. Rejecting it
  // here would make desktop and mobile disagree about one link.
  it('accepts an uppercase scheme, because scheme case is not significant', () => {
    expect(parseDirectShareRoute('DAAK://send?deviceId=abc123')).toEqual({ deviceId: 'abc123' });
  });

  // Same reasoning one level down: mobile lowercases the host before
  // comparing, so daak://SEND is the same route in both apps.
  it('accepts an uppercase host', () => {
    expect(parseDirectShareRoute('daak://SEND?deviceId=abc123')).toEqual({ deviceId: 'abc123' });
  });

  // searchParams decodes, so a percent-escaped id is the id -- which is the
  // property a raw query-string slice would NOT have.
  it('percent-decodes the device parameter', () => {
    expect(parseDirectShareRoute('daak://send?deviceId=%61bc')).toEqual({ deviceId: 'abc' });
  });

  // The fragment is not part of the query and cannot reach the id (URL splits
  // it off before searchParams sees anything), so it is ignored rather than
  // rejected.
  it('ignores a trailing fragment and a trailing slash', () => {
    expect(parseDirectShareRoute('daak://send/?deviceId=abc#frag')).toEqual({ deviceId: 'abc' });
  });

  // The device-id SHAPE is deliberately NOT checked here. daakd enforces it at
  // the only place that decodes it -- crates/daakd/src/lib.rs:96 parse_id
  // rejects anything that is not 32 hex chars -- and the plan's own case above
  // uses 'abc123'. Duplicating the rule here would be a second validator to
  // keep in step with the engine for no extra safety.
  it('passes an oddly shaped id through for the engine to reject', () => {
    const long = 'z'.repeat(40);
    expect(parseDirectShareRoute(`daak://send?deviceId=${long}`)).toEqual({ deviceId: long });
  });
});

// ---- the react-native-macos URL shim ----
//
// apps/desktop runs react-native-macos, which replaces the global URL with
// Libraries/Blob/URL.js from that package. That class is Blob-only: the
// constructor stores the string and throws on the first accessor.
//
//   node_modules/.pnpm/react-native-macos@0.76.5_*/node_modules/
//     react-native-macos/Libraries/Blob/URL.js:142
//   get protocol(): string {
//     throw new Error('URL.protocol is not implemented');
//
// The user saw that text. The vitest suite stayed green because vitest runs on
// Node, where URL is the real WHATWG class, so this suite could never see the
// defect.
//
// This is a LOCAL copy of the shim on purpose. The real file is Flow source
// that imports a native module, so it cannot load under vitest. The copy keeps
// the constructor permissive and every accessor throwing, which is the part
// of the real class that matters here.
class RNBlobURLSearchParams {
  get(): string {
    throw new Error('URLSearchParams.get is not implemented');
  }
  getAll(): string[] {
    throw new Error('URLSearchParams.getAll is not implemented');
  }
}

class RNBlobURL {
  private readonly _url: string;
  constructor(url: string) {
    this._url = url;
  }
  get hash(): string {
    throw new Error('URL.hash is not implemented');
  }
  get host(): string {
    throw new Error('URL.host is not implemented');
  }
  get hostname(): string {
    throw new Error('URL.hostname is not implemented');
  }
  get origin(): string {
    throw new Error('URL.origin is not implemented');
  }
  get password(): string {
    throw new Error('URL.password is not implemented');
  }
  get pathname(): string {
    throw new Error('URL.pathname not implemented');
  }
  get port(): string {
    throw new Error('URL.port is not implemented');
  }
  get protocol(): string {
    throw new Error('URL.protocol is not implemented');
  }
  get search(): string {
    throw new Error('URL.search is not implemented');
  }
  get searchParams(): RNBlobURLSearchParams {
    return new RNBlobURLSearchParams();
  }
  get username(): string {
    throw new Error('URL.username is not implemented');
  }
  toString(): string {
    return this._url;
  }
}

describe('parseDirectShareRoute under the react-native-macos URL shim', () => {
  // react-native's types declare a global `URL` CLASS but no `var URL`, so
  // `globalThis.URL` does not typecheck under this package's tsconfig (types:
  // ["react-native", "node"]). The swap goes through one narrow record so the
  // cast appears once instead of on every assignment.
  const globalSlot = globalThis as unknown as { URL: typeof URL };
  const realURL = globalSlot.URL;

  beforeEach(() => {
    globalSlot.URL = RNBlobURL as unknown as typeof URL;
  });

  afterEach(() => {
    globalSlot.URL = realURL;
  });

  // Non-vacuity check. Without it a future edit that stopped installing the
  // shim would turn every case below into a duplicate of the block above and
  // this suite would be green for the wrong reason again.
  it('installs a global URL whose accessors throw', () => {
    expect(() => new URL('daak://send?deviceId=abc').protocol).toThrow(
      'URL.protocol is not implemented',
    );
  });

  it('reads a real direct-share link', () => {
    expect(parseDirectShareRoute('daak://send?deviceId=abc123')).toEqual({ deviceId: 'abc123' });
  });

  it('decodes the device parameter', () => {
    expect(parseDirectShareRoute('daak://send?deviceId=%61bc')).toEqual({ deviceId: 'abc' });
  });

  it('accepts a case-insensitive scheme and host', () => {
    expect(parseDirectShareRoute('DAAK://SEND?deviceId=abc123')).toEqual({ deviceId: 'abc123' });
  });

  it('keeps every rejection a null, not a thrown shim error', () => {
    const rejected = [
      'https://send?deviceId=abc',
      'daak://open?deviceId=abc',
      'daak://send',
      'daak://send:1234?deviceId=abc',
      'daak://send?deviceId=aaa&deviceId=bbb',
      'not a url',
      '',
    ];
    for (const url of rejected) {
      expect(parseDirectShareRoute(url)).toBeNull();
    }
  });

  // The malformed-escape rule, pinned. Deleting the try/catch in
  // percentDecode makes the parser throw URIError on these three, and no other
  // case in this file covers it: the file's other decode case is a WELL-FORMED
  // escape (%61bc). Mobile pins the same rule with `deviceId=%%` at
  // apps/mobile/src/__tests__/deeplink.test.ts:29.
  it('fails closed on a malformed escape instead of throwing', () => {
    for (const bad of ['%zz', '%', '%2']) {
      expect(() => parseDirectShareRoute(`daak://send?deviceId=${bad}`)).not.toThrow();
      expect(parseDirectShareRoute(`daak://send?deviceId=${bad}`)).toBeNull();
    }
  });
});
