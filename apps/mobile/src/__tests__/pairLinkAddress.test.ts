// A `daak://pair` link that NAMES NO PORT cannot pair on a network where mDNS
// does not cross. The joiner resolves the host's address from the discovery
// map, so the only evidence it has of where to dial is an announce it may
// never receive. Measured on the Android emulator (10.0.2.16, NAT): the CLI
// saw the emulator advertise, the app saw nothing, and every link join failed
// with `unknown device` even though the bundle was valid.
//
// So the link carries the address. The bundle CBOR is unchanged: it is a
// frozen identity blob and adding a field to it is a wire change. The
// `daak://` URL is not CBOR and has no schema, so `addr` is additive there.
import { parseDeepLink } from '../deeplink';

describe('a pair link that carries an address', () => {
  const addr = '192.168.0.226:50790';
  const bundleJson = JSON.stringify({
    cbor: 'aabb',
    name: 'host',
    device_id: '11'.repeat(16),
  });

  function link(extra: string): string {
    return `daak://pair?bundle=${encodeURIComponent(bundleJson)}${extra}`;
  }

  it('reads the addr out of the link', () => {
    expect(parseDeepLink(link(`&addr=${addr}`))).toEqual({
      kind: 'pair',
      bundle: bundleJson,
      addr,
    });
  });

  // BACKWARD COMPATIBLE: a link with no `addr` still parses, because a QR the
  // user already had on screen must keep working on a LAN where mDNS does.
  it('still parses a link with no addr', () => {
    expect(parseDeepLink(link(''))).toEqual({ kind: 'pair', bundle: bundleJson });
  });

  it('fails closed on a malformed addr rather than passing it to the dialer', () => {
    expect(parseDeepLink(link('&addr=not-an-address'))).toEqual({ kind: 'none' });
  });

  it('rejects an empty addr', () => {
    expect(parseDeepLink(link('&addr='))).toEqual({ kind: 'none' });
  });

});
