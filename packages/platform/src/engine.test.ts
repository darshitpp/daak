import { beforeEach, describe, expect, it } from 'vitest';
import { bindDaakEvents, createEngine } from './engine';
import type { DaakEvent } from '@daak/core';
import type { Spec as NativeDaakSpec } from '@daak/core/src/NativeDaak';
import type { EventSubscribe } from './engine';
// react-native is aliased to the typed stub for tests (see vitest.config.ts);
// its test-only emitters are not part of the real package's public types.
import { __emit as emit, __reset as resetStub } from '../test/react-native-stub';

// The shape BOTH native emitters actually put on the wire:
//   Daak.swift:147  sendEvent(withName: "DaakEvent", body: ["event": json])
//   DaakModule.kt  map.putString("event", json)
// i.e. an OBJECT, never a bare DaakEvent.
const PROGRESS = { type: 'transfer.progress', transferId: 't', bytesDone: 1, bytesTotal: 2 } as const;
const nativePayload = { event: JSON.stringify(PROGRESS) };

function fakeNative(calls: unknown[][]): NativeDaakSpec {
  return {
    start: async (...a) => { calls.push(['start', ...a]); },
    shutdown: async () => { calls.push(['shutdown']); },
    listDevices: async () => JSON.stringify([]),
    revokePairing: async (id) => { calls.push(['revokePairing', id]); },
    confirmPairing: async (id) => { calls.push(['confirmPairing', id]); },
    backgroundWake: async () => { calls.push(['backgroundWake']); },
    replaceInboxPaths: async (id, paths) => { calls.push(['replaceInboxPaths', id, paths]); },
    pairingBundle: async () => '{}',
    pairWith: async (addr, bytes) => { calls.push(['pairWith', addr, bytes.length]); return '123456'; },
    offerPairing: async (bytes) => { calls.push(['offerPairing', bytes.length]); },
    armHostPairing: async () => { calls.push(['armHostPairing']); },
    armCodePairing: async () => { calls.push(['armCodePairing']); return '123456'; },
    pairWithCode: async (addr, code) => { calls.push(['pairWithCode', addr, code]); return '{"sas":"123456","peer_device_id":"aa"}'; },
    codePairingStatus: async () => JSON.stringify({ state: 'idle', remaining_ms: 0, tries_left: 0 }),
    cancelCodePairing: async () => { calls.push(['cancelCodePairing']); },
    acceptPairing: async () => '123456',
    sendText: async (peer, text) => { calls.push(['sendText', peer, text]); return 'aa'.repeat(16); },
    sendFiles: async (peer, paths) => { calls.push(['sendFiles', peer, paths]); return 'bb'.repeat(16); },
    listInbox: async () => '[]',
    listTransfers: async () => '[]',
    listThread: async () => JSON.stringify({ items: [], olderCursor: null }),
    getItemText: async () => '',
    cancel: async () => {},
    retry: async () => {},
    retryItem: async () => {},
    quarantineReport: async () => JSON.stringify({ transferId: 'aa'.repeat(16), itemIndex: 0 }),
    listQuarantineReports: async () => '[]',
    deleteQuarantined: async () => {},
    setDisplayName: async () => {},
    setPresence: async () => {},
    selfProfile: async () =>
      JSON.stringify({ name: 'Test Device', baseName: 'Test Device', deviceId: 'dd'.repeat(16) }),
    localPort: async () => 40001,
    addListener: () => {},
    removeListeners: () => {},
  };
}

describe('createEngine', () => {
  beforeEach(() => resetStub());

  it('binds the native module and decodes the { event: json } payload', async () => {
    const calls: unknown[][] = [];
    const native = fakeNative(calls);
    // A list, not a `let handler`: the only assignment happens inside a closure
    // TS cannot see, so a narrowed `let` collapses to `never` and fails to
    // compile. Indexing the list keeps the type honest and the check real.
    const subscribed: Parameters<EventSubscribe>[0][] = [];
    const subscribe: EventSubscribe = (cb) => {
      subscribed.push(cb);
      return () => { subscribed.length = 0; };
    };

    const engine = createEngine(native, subscribe);
    const seen: DaakEvent[] = [];
    engine.on((e) => seen.push(e));
    await engine.start();
    expect(subscribed).toHaveLength(1);
    subscribed[0](nativePayload);

    expect(calls[0][0]).toBe('start');
    expect(seen).toEqual([PROGRESS]);
  });

  // The regression this guards: an adapter that re-wraps the payload before
  // InProcessEngine unwraps it drops EVERY event in production, while an
  // injected double that hands over a bare DaakEvent still passes.
  it('delivers events end to end through bindDaakEvents and the RN emitter', async () => {
    const calls: unknown[][] = [];
    const native = fakeNative(calls);
    const engine = createEngine(native, bindDaakEvents(native));
    const seen: DaakEvent[] = [];
    engine.on((e) => seen.push(e));

    emit('DaakEvent', nativePayload);

    expect(seen).toEqual([PROGRESS]);
  });

  it('stops delivering after the disposer runs', () => {
    const native = fakeNative([]);
    const engine = createEngine(native, bindDaakEvents(native));
    const seen: DaakEvent[] = [];
    const off = engine.on((e) => seen.push(e));
    off();
    emit('DaakEvent', nativePayload);
    expect(seen).toEqual([]);
  });

  // Minor 3: the fake recorded offerPairing into `calls` and NOTHING read it,
  // so a host-arm that silently stopped reaching the native module would have
  // stayed green. The hex string must reach the module as BYTES.
  it('hands the host arm to the native module as decoded bytes', async () => {
    const calls: unknown[][] = [];
    const engine = createEngine(fakeNative(calls), bindDaakEvents(fakeNative(calls)));

    await engine.offerPairing('aabbcc');

    expect(calls).toContainEqual(['offerPairing', 3]);
  });

  // The arm a real user reaches (spec 3.3 Mode A). It carries NO payload, so
  // unlike offerPairing there is nothing to decode -- which is precisely why
  // the bundle-taking arm could not be reached by a real user, and why this one
  // is the one the host flow must call.
  it('arms the host with no payload at all', async () => {
    const calls: unknown[][] = [];
    const native = fakeNative(calls);
    const engine = createEngine(native, bindDaakEvents(native));

    await engine.armHostPairing();

    expect(calls).toContainEqual(['armHostPairing']);
  });
});
