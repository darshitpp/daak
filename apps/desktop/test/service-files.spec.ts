import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaakEngine, DeviceInfo } from '@daak/core/src/engine/types';
import { NativeEventEmitter, NativeModules } from 'react-native';
import { getDirectSharePeer, setDirectSharePeer } from '../src/direct-share';
import {
  consumeServiceFiles,
  getServiceFiles,
  onServiceFiles,
  pullServiceFiles,
  sendServiceFiles,
  setServiceFiles,
  subscribeServiceFiles,
} from '../src/service-files';

// NativeModules is a plain index signature at runtime. The test asserts on the
// call, not on the types.
interface BridgeModules {
  DaakSystemShare?: { takePendingFiles(): Promise<unknown> };
  DaakWindowHost?: { openDashboard(): Promise<void>; closePopover(): Promise<void> };
}
const mods = NativeModules as BridgeModules;

const device: DeviceInfo = { deviceId: 'abc', name: 'Peer', addr: '10.0.0.2:4242' };

function stubPending(result: unknown) {
  const spy = vi.fn(() => Promise.resolve(result));
  mods.DaakSystemShare = { takePendingFiles: spy };
  return spy;
}

function stubWindowHost(openDashboard: () => Promise<void>) {
  const spy = vi.fn(openDashboard);
  mods.DaakWindowHost = { openDashboard: spy, closePopover: vi.fn(() => Promise.resolve()) };
  return spy;
}

describe('the service-files store', () => {
  beforeEach(() => {
    consumeServiceFiles();
    setDirectSharePeer(null);
    delete mods.DaakSystemShare;
    delete mods.DaakWindowHost;
  });

  it('setServiceFiles stores the paths and bumps the token', () => {
    const before = getServiceFiles();
    expect(before).toBeNull();
    setServiceFiles(['/tmp/a.txt']);
    const value = getServiceFiles();
    expect(value?.files).toEqual(['/tmp/a.txt']);
    expect(value?.token).toBeGreaterThan(0);
  });

  it('getServiceFiles returns the same object until the next set', () => {
    setServiceFiles(['/tmp/a.txt']);
    expect(Object.is(getServiceFiles(), getServiceFiles())).toBe(true);
  });

  it('a second set replaces the first and gives a higher token', () => {
    setServiceFiles(['/tmp/a.txt']);
    const first = getServiceFiles()!;
    setServiceFiles(['/tmp/b.txt']);
    const second = getServiceFiles()!;
    expect(second.files).toEqual(['/tmp/b.txt']);
    expect(second.token).toBeGreaterThan(first.token);
  });

  it('the same paths set twice give two different tokens', () => {
    setServiceFiles(['/tmp/a.txt']);
    const first = getServiceFiles()!;
    setServiceFiles(['/tmp/a.txt']);
    expect(getServiceFiles()!.token).not.toBe(first.token);
  });

  it('the token still rises after a consume', () => {
    setServiceFiles(['/tmp/a.txt']);
    const first = getServiceFiles()!;
    consumeServiceFiles();
    setServiceFiles(['/tmp/a.txt']);
    expect(getServiceFiles()!.token).toBeGreaterThan(first.token);
  });

  it('consumeServiceFiles clears the value and notifies subscribers once', () => {
    setServiceFiles(['/tmp/a.txt']);
    const listener = vi.fn();
    const off = subscribeServiceFiles(listener);
    consumeServiceFiles();
    expect(getServiceFiles()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn();
    const off = subscribeServiceFiles(listener);
    off();
    setServiceFiles(['/tmp/a.txt']);
    expect(listener).not.toHaveBeenCalled();
  });

  it('setServiceFiles clears the direct-share peer first', () => {
    setDirectSharePeer('abc');
    setServiceFiles(['/tmp/a.txt']);
    expect(getDirectSharePeer()).toBeNull();
  });

  it('a path with spaces and non-ASCII characters is stored unchanged', () => {
    setServiceFiles(['/tmp/my file é.txt']);
    expect(getServiceFiles()?.files).toEqual(['/tmp/my file é.txt']);
  });
});

describe('pullServiceFiles', () => {
  beforeEach(() => {
    consumeServiceFiles();
    delete mods.DaakSystemShare;
    delete mods.DaakWindowHost;
  });

  it('does nothing for an empty list', async () => {
    stubPending([]);
    const opened = stubWindowHost(() => Promise.resolve());
    await pullServiceFiles();
    expect(getServiceFiles()).toBeNull();
    expect(opened).not.toHaveBeenCalled();
  });

  it('does nothing for a non-array result', async () => {
    stubPending('nope');
    const opened = stubWindowHost(() => Promise.resolve());
    await pullServiceFiles();
    expect(getServiceFiles()).toBeNull();
    expect(opened).not.toHaveBeenCalled();
  });

  it('stores the paths, then opens the dashboard', async () => {
    stubPending(['/tmp/a.txt', '/tmp/b.txt']);
    const seen: (string[] | undefined)[] = [];
    stubWindowHost(() => {
      seen.push(getServiceFiles()?.files);
      return Promise.resolve();
    });
    await pullServiceFiles();
    expect(seen).toEqual([['/tmp/a.txt', '/tmp/b.txt']]);
  });

  it('resolves when the native module is absent', async () => {
    await expect(pullServiceFiles()).resolves.toBeUndefined();
    expect(getServiceFiles()).toBeNull();
  });

  it('resolves and keeps the files when openDashboard rejects', async () => {
    stubPending(['/tmp/a.txt']);
    stubWindowHost(() => Promise.reject(new Error('E_OPEN')));
    await expect(pullServiceFiles()).resolves.toBeUndefined();
    expect(getServiceFiles()?.files).toEqual(['/tmp/a.txt']);
  });

  it('resolves when the native call rejects', async () => {
    mods.DaakSystemShare = { takePendingFiles: vi.fn(() => Promise.reject(new Error('E_X'))) };
    await expect(pullServiceFiles()).resolves.toBeUndefined();
    expect(getServiceFiles()).toBeNull();
  });
});

describe('sendServiceFiles', () => {
  beforeEach(() => consumeServiceFiles());

  it('calls engine.send with the device id and the files, then clears the store', async () => {
    setServiceFiles(['/tmp/a.txt']);
    const send = vi.fn(() => Promise.resolve({ transferId: 't', queued: true }));
    const engine = { send } as unknown as DaakEngine;
    await sendServiceFiles(engine, device, { files: ['/tmp/a.txt'] });
    expect(send).toHaveBeenCalledWith({ peerDeviceId: 'abc', files: ['/tmp/a.txt'] });
    expect(getServiceFiles()).toBeNull();
  });

  it('leaves the store unchanged when engine.send rejects', async () => {
    setServiceFiles(['/tmp/a.txt']);
    const before = getServiceFiles();
    const engine = { send: vi.fn(() => Promise.reject(new Error('boom'))) } as unknown as DaakEngine;
    await expect(sendServiceFiles(engine, device, { files: ['/tmp/a.txt'] })).rejects.toThrow('boom');
    expect(Object.is(getServiceFiles(), before)).toBe(true);
  });
});

describe('onServiceFiles', () => {
  beforeEach(() => {
    delete mods.DaakSystemShare;
  });

  it('does nothing and does not throw when the native module is absent', () => {
    let off: (() => void) | undefined;
    expect(() => {
      off = onServiceFiles();
    }).not.toThrow();
    expect(() => off!()).not.toThrow();
    expect(() => onServiceFiles()()).not.toThrow();
  });
});

// The shared stub emitter cannot fire events. This block replaces addListener on
// the stub class for each test and restores it after.
describe('onServiceFiles with the native module present', () => {
  const proto = NativeEventEmitter.prototype;
  const original = proto.addListener;
  let handlers: Array<() => void>;
  let names: string[];
  let remove: ReturnType<typeof vi.fn>;
  let pending: string[][];
  let take: ReturnType<typeof vi.fn>;

  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  beforeEach(() => {
    consumeServiceFiles();
    handlers = [];
    names = [];
    remove = vi.fn();
    pending = [];
    proto.addListener = function (event: string, cb: (e: unknown) => void) {
      names.push(event);
      handlers.push(() => cb(undefined));
      return { remove: remove as () => void } as never;
    };
    take = vi.fn(() => Promise.resolve(pending.shift() ?? []));
    mods.DaakSystemShare = { takePendingFiles: take };
    stubWindowHost(() => Promise.resolve());
  });

  afterEach(() => {
    proto.addListener = original;
    delete mods.DaakSystemShare;
    delete mods.DaakWindowHost;
  });

  it('pulls once and listens for DaakServiceFilesPending', async () => {
    onServiceFiles();
    await flush();
    expect(take).toHaveBeenCalledTimes(1);
    expect(names).toEqual(['DaakServiceFilesPending']);
  });

  it('pulls again when the event fires', async () => {
    onServiceFiles();
    await flush();
    handlers[0]();
    await flush();
    expect(take).toHaveBeenCalledTimes(2);
  });

  it('the returned function removes the subscription', () => {
    const off = onServiceFiles();
    off();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('two events with different paths leave the newest paths and a higher token', async () => {
    onServiceFiles();
    await flush();
    pending.push(['/tmp/a.txt']);
    handlers[0]();
    await flush();
    const first = getServiceFiles()!;
    pending.push(['/tmp/b.txt']);
    handlers[0]();
    await flush();
    const second = getServiceFiles()!;
    expect(first.files).toEqual(['/tmp/a.txt']);
    expect(second.files).toEqual(['/tmp/b.txt']);
    expect(second.token).toBeGreaterThan(first.token);
  });
});
