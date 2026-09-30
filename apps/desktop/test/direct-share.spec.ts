import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyDirectShareUrl,
  devicesToMenuJson,
  getDirectSharePeer,
  onDirectShareUrl,
  publishDevices,
  setDirectSharePeer,
  subscribeDirectSharePeer,
} from '../src/direct-share';
import { Linking, NativeModules } from 'react-native';

// One typed view of the bridge for every native module these tests stand in for.
// NativeModules is a plain index signature at runtime, so the casts below are the
// same cast src/direct-share.ts and src/window-host.ts make -- the test asserts on
// the CALL, not on the types.
interface BridgeModules {
  DaakDirectShare?: { setDevices(json: string): Promise<void> };
  DaakWindowHost?: { openDashboard(): Promise<void>; closePopover(): Promise<void> };
}
const mods = NativeModules as BridgeModules;

// The stub Linking, typed once. Assigning to a narrower object literal type and
// then reading a property that was not in it is a type error even when it is the
// very same object at runtime, so the whole surface is declared up front.
interface StubLinking {
  getInitialURL(): Promise<string | null>;
  addEventListener(type: 'url', cb: (e: { url: string }) => void): { remove(): void };
}
const linking = Linking as StubLinking;

function stubWindowHost(openDashboard: () => Promise<void>) {
  const spy = vi.fn(openDashboard);
  mods.DaakWindowHost = { openDashboard: spy, closePopover: vi.fn(() => Promise.resolve()) };
  return spy;
}

// The serialiser is the part that can be wrong without anything noticing: a
// malformed payload reaches the native menu builder, which rejects it, and the
// Share menu then silently keeps whatever it had. So the shape of the JSON is
// pinned here, on the real DeviceInfo shape (@daak/core DeviceInfo).
describe('devicesToMenuJson', () => {
  it('emits only deviceId and name, which is all the menu renders', () => {
    const json = devicesToMenuJson([
      { deviceId: '0a1b', name: "Alice's Mac", addr: '192.168.1.4:4242', online: true },
      { deviceId: '5f4e', name: 'Windows Box', addr: '192.168.1.9:4242' },
    ]);
    // `addr` is deliberately dropped: it is a LAN address the menu never shows,
    // and the payload crosses into a native menu with no use for it.
    expect(JSON.parse(json)).toEqual([
      { deviceId: '0a1b', name: "Alice's Mac" },
      { deviceId: '5f4e', name: 'Windows Box' },
    ]);
  });

  it('emits an empty array for no devices, which is the nothing-paired state', () => {
    expect(devicesToMenuJson([])).toBe('[]');
  });

  it('keeps the online flag out of the payload', () => {
    const json = devicesToMenuJson([{ deviceId: '0a1b', name: 'x', addr: 'a', online: false }]);
    expect(JSON.parse(json)).toEqual([{ deviceId: '0a1b', name: 'x' }]);
  });

  it('publishes a nameless device rather than hiding it', () => {
    // The native side skips an entry with no name and, if it was the only one,
    // rejects. Hiding it here would make the menu claim nothing is paired for a
    // device that IS paired -- a different, quieter lie.
    const nameless = devicesToMenuJson([{ deviceId: '0a1b', addr: 'a' } as never]);
    expect(JSON.parse(nameless)).toEqual([{ deviceId: '0a1b', name: '' }]);
  });
});

// The native module is reached through NativeModules, exactly like
// src/window-host.ts reaches DaakWindowHost, and it is ABSENT on every build
// that is not this macOS one. So publishDevices has to be a no-op there rather
// than a throw, and a native rejection has to be swallowed: an unhandled
// rejection from a menu publish is not a useful signal to anyone.
describe('publishDevices', () => {
  it('swallows a missing native module instead of throwing', async () => {
    delete mods.DaakDirectShare;
    await expect(publishDevices([{ deviceId: 'a', name: 'b', addr: 'c' }])).resolves.toBeUndefined();
  });

  it('swallows a native rejection instead of leaving it unhandled', async () => {
    mods.DaakDirectShare = { setDevices: vi.fn(() => Promise.reject(new Error('E_BAD_DEVICES'))) };
    await expect(publishDevices([{ deviceId: 'a', name: 'b', addr: 'c' }])).resolves.toBeUndefined();
    delete mods.DaakDirectShare;
  });

  it('passes the serialised device list to the native module', async () => {
    const setDevices = vi.fn(() => Promise.resolve());
    mods.DaakDirectShare = { setDevices };
    await publishDevices([{ deviceId: '0a1b', name: "Alice's Mac", addr: 'x' }]);
    expect(setDevices).toHaveBeenCalledWith('[{"deviceId":"0a1b","name":"Alice\'s Mac"}]');
    delete mods.DaakDirectShare;
  });
});

// The INBOUND half. Everything the reviewer called "retained but never
// applied": a daak:// link that is parsed and thrown away is not routing, and
// the dashboard window is already mounted when the link arrives, so a plain
// local variable would be invisible to it.
const ID = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';

describe('the direct-share target store', () => {
  beforeEach(() => setDirectSharePeer(null));

  it('starts empty, so an unlinked launch keeps the devices[0] default', () => {
    expect(getDirectSharePeer()).toBeNull();
  });

  it('notifies subscribers when the target changes', () => {
    const listener = vi.fn();
    const off = subscribeDirectSharePeer(listener);
    setDirectSharePeer(ID);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getDirectSharePeer()).toBe(ID);
    off();
  });

  // useSyncExternalStore would loop forever on an identity that changes every
  // notification, and two links naming the same device is not two changes.
  it('does not notify when the target is unchanged', () => {
    const listener = vi.fn();
    setDirectSharePeer(ID);
    const off = subscribeDirectSharePeer(listener);
    setDirectSharePeer(ID);
    expect(listener).not.toHaveBeenCalled();
    off();
  });

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn();
    const off = subscribeDirectSharePeer(listener);
    off();
    setDirectSharePeer(ID);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('applyDirectShareUrl', () => {
  beforeEach(() => setDirectSharePeer(null));

  it('records the device id from a valid send route', () => {
    expect(applyDirectShareUrl(`daak://send?deviceId=${ID}`)).toBe(true);
    expect(getDirectSharePeer()).toBe(ID);
  });

  // The dashboard is mounted at launch and merely orderOut, so opening first
  // would order the window in pointing at devices[0] and paint one wrong-peer
  // frame before the target landed. The order is observable, so it is pinned.
  it('sets the target BEFORE the window opens', () => {
    const seen: (string | null)[] = [];
    stubWindowHost(() => {
      seen.push(getDirectSharePeer());
      return Promise.resolve();
    });
    applyDirectShareUrl(`daak://send?deviceId=${ID}`);
    expect(seen).toEqual([ID]);
    delete mods.DaakWindowHost;
  });

  it.each([
    'not a url',
    '',
    'daak://open?deviceId=x',
    'daak://send',
    null,
  ])('leaves the target alone and opens nothing for %s', (url) => {
    const opened = stubWindowHost(() => Promise.resolve());
    expect(applyDirectShareUrl(url as string | null)).toBe(false);
    expect(getDirectSharePeer()).toBeNull();
    expect(opened).not.toHaveBeenCalled();
    delete mods.DaakWindowHost;
  });
});

// getInitialURL and addEventListener cover DIFFERENT launches, so a
// subscription that has only one of them misses a cold start or a warm one.
describe('onDirectShareUrl', () => {
  beforeEach(() => setDirectSharePeer(null));

  it('applies the cold-launch URL from getInitialURL', async () => {
    linking.getInitialURL = () => Promise.resolve(`daak://send?deviceId=${ID}`);
    onDirectShareUrl();
    await Promise.resolve();
    await Promise.resolve();
    expect(getDirectSharePeer()).toBe(ID);
  });

  it('applies a URL delivered to the already-running app', () => {
    let deliver: ((e: { url: string }) => void) | undefined;
    linking.addEventListener = (_t, cb) => {
      deliver = cb;
      return { remove() {} };
    };
    linking.getInitialURL = () => Promise.resolve(null);
    onDirectShareUrl();
    deliver!({ url: `daak://send?deviceId=${ID}` });
    expect(getDirectSharePeer()).toBe(ID);
  });

  // getInitialURL REJECTS on a machine where nothing registered the daak
  // scheme, and an unhandled rejection takes the process down for a link that
  // was entirely optional.
  it('survives a rejecting getInitialURL', async () => {
    linking.getInitialURL = () => Promise.reject(new Error('no handler'));
    expect(() => onDirectShareUrl()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(getDirectSharePeer()).toBeNull();
  });
});
