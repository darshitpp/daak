import { describe, expect, it } from 'vitest';
import type { DaakEngine, DaakEvent, DeviceInfo } from '../src/engine/types';
import { InProcessEngine } from '../src/engine/InProcess';
// Type-only: importing the module for value would run getEnforcing and throw
// outside a React Native runtime.
import type { Spec as NativeDaakSpec } from '../src/NativeDaak';

const METHODS: (keyof DaakEngine)[] = [
  'start', 'stop', 'devices', 'pair', 'send', 'cancel',
  'retry', 'listTransfers', 'listInbox', 'setDisplayName', 'setPresence', 'on',
];

// Compile-time only: adding, removing or renaming a DaakEvent member breaks tsc.
const EVENT_TYPES: Record<DaakEvent['type'], true> = {
  'device.discovered': true,
  'device.state': true,
  'pairing.sas': true,
  'pairing.done': true,
  'transfer.progress': true,
  'transfer.item': true,
  'transfer.done': true,
  'transfer.failed': true,
  'inbox.received': true,
};

// Compile-time only: the native modules (DaakModule.kt, Daak.swift) override
// exactly these methods, so adding, removing or renaming one here breaks tsc on
// the spec and, at build time, the generated NativeDaakSpec.
// getConstants is excluded because RN's TurboModule base declares it optional
// and neither native module implements it; Exclude keeps the pin honest without
// adding a key nothing overrides.
type NativeMethods = Exclude<keyof NativeDaakSpec, 'getConstants'>;
const NATIVE_METHODS: Record<NativeMethods, true> = {
  start: true,
  pairingBundle: true,
  pairWith: true,
  acceptPairing: true,
  sendText: true,
  sendFiles: true,
  listDevices: true,
  cancel: true,
  retry: true,
  localPort: true,
  shutdown: true,
  addListener: true,
  removeListeners: true,
};

export function assertEngineShape(engine: DaakEngine): void {
  const methods: (keyof DaakEngine)[] = METHODS;
  for (const m of methods) expect(typeof engine[m]).toBe('function');
}

describe('contract types', () => {
  it('exposes the documented event union', () => {
    const e: DaakEvent = { type: 'transfer.progress', transferId: 'x', bytesDone: 1, bytesTotal: 2 };
    expect(e.type).toBe('transfer.progress');
  });

  it('pins the engine method set to spec 6.2', () => {
    const exhaustive: Record<keyof DaakEngine, true> = {
      start: true, stop: true, devices: true, pair: true, send: true, cancel: true,
      retry: true, listTransfers: true, listInbox: true, setDisplayName: true,
      setPresence: true, on: true,
    };
    expect(Object.keys(EVENT_TYPES).length).toBe(9);
    expect(Object.keys(exhaustive).length).toBe(METHODS.length);
  });

  it('pins the TurboModule spec the native modules implement', () => {
    expect(Object.keys(NATIVE_METHODS).length).toBe(13);
  });

  it('models a device without fabricating liveness (R11)', () => {
    const discovered: DeviceInfo = { deviceId: 'd1', name: 'peer', addr: '10.0.0.2:9000' };
    expect(discovered.online).toBeUndefined();
  });
});

// A native module stand-in. Only the methods a test touches are real; the rest
// throw so an unstubbed call fails loudly instead of resolving undefined.
function fakeNative(over: Partial<Record<string, unknown>> = {}): any {
  return {
    start: async () => {},
    shutdown: async () => {},
    localPort: async () => 1234,
    pairingBundle: async () => '{}',
    addListener: () => {},
    removeListeners: () => {},
    ...over,
  };
}

describe('InProcessEngine', () => {
  it('maps raw event JSON into the typed union (R17)', () => {
    const emitted: DaakEvent[] = [];
    const engine = new InProcessEngine(fakeNative(), (cb) => {
      cb(JSON.stringify({ type: 'transfer.progress', transferId: 't1', bytesDone: 5, bytesTotal: 10 }));
      return () => {};
    });
    engine.on((e) => emitted.push(e));
    expect(emitted).toEqual([
      { type: 'transfer.progress', transferId: 't1', bytesDone: 5, bytesTotal: 10 },
    ]);
  });

  it('drops an unparseable event instead of throwing at the trust boundary', () => {
    const emitted: DaakEvent[] = [];
    const engine = new InProcessEngine(fakeNative(), (cb) => {
      cb('not json');
      cb(JSON.stringify({ nope: 1 }));
      cb(JSON.stringify({ type: 'transfer.done', transferId: 't2' }));
      return () => {};
    });
    engine.on((e) => emitted.push(e));
    expect(emitted).toEqual([{ type: 'transfer.done', transferId: 't2' }]);
  });

  it('resolves the peer addr and hex bundle before pairing (R13)', async () => {
    const calls: unknown[][] = [];
    const native = fakeNative({
      listDevices: async () => JSON.stringify([{ deviceId: 'd1', name: 'peer', addr: '10.0.0.2:9000' }]),
      pairWith: async (addr: string, cbor: number[]) => {
        calls.push([addr, cbor]);
        return JSON.stringify({ sas: '1-2-3', peer_device_id: 'd1' });
      },
    });
    const engine = new InProcessEngine(native, () => () => {});
    expect(await engine.pair('d1', 'qr', 'a1b2')).toEqual({ sas: '1-2-3' });
    expect(calls).toEqual([['10.0.0.2:9000', [0xa1, 0xb2]]]);
  });

  it('refuses to pair with an unknown device', async () => {
    const native = fakeNative({ listDevices: async () => '[]' });
    const engine = new InProcessEngine(native, () => () => {});
    await expect(engine.pair('nope', 'qr', 'a1b2')).rejects.toThrow(/nope/);
  });

  it('parses the device list and rejects a non-array payload', async () => {
    const good = new InProcessEngine(fakeNative({
      listDevices: async () => '[{"deviceId":"d1","name":"peer","addr":"10.0.0.2:9000"}]',
    }), () => () => {});
    expect(await good.devices()).toEqual([{ deviceId: 'd1', name: 'peer', addr: '10.0.0.2:9000' }]);

    const bad = new InProcessEngine(fakeNative({ listDevices: async () => '{}' }), () => () => {});
    await expect(bad.devices()).rejects.toThrow(/listDevices/);
  });

  it('routes text-only to sendText, otherwise sendFiles, and always queues (R7)', async () => {
    const calls: string[] = [];
    const native = fakeNative({
      sendText: async (peer: string) => { calls.push(`text:${peer}`); return 'abcd'; },
      sendFiles: async (peer: string) => { calls.push(`files:${peer}`); return 'ef01'; },
    });
    const engine = new InProcessEngine(native, () => () => {});
    expect(await engine.send({ peerDeviceId: 'd1', text: 'hi' })).toEqual({ transferId: 'abcd', queued: true });
    expect(await engine.send({ peerDeviceId: 'd1', text: 'hi', files: ['/a'] })).toEqual({ transferId: 'ef01', queued: true });
    expect(calls).toEqual(['text:d1', 'files:d1']);
  });
});
