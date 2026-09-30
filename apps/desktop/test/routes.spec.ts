import { describe, expect, it } from 'vitest';
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
