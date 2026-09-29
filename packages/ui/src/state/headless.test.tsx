import { createUiRuntime, type UiRuntime } from '../headless';
import type { UiState } from './store';
import { fakeEngine } from '../testing/fakeEngine';
import type { DaakEvent, DeviceInfo } from '@daak/core';

function emitters(engine: ReturnType<typeof fakeEngine>) {
  const handlers = (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers;
  return {
    count: () => handlers.size,
    fire: (e: DaakEvent) => handlers.forEach((h) => h(e)),
  };
}

// F5: a rejecting devices() must be silent. Every test in this file shares one
// process, so a leaked unhandled rejection shows up here whether or not the
// test that caused it was still running.
const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

describe('createUiRuntime', () => {
  it('folds engine events into state and stops after unsubscribe', () => {
    const engine = fakeEngine();
    const bus = emitters(engine);
    const runtime = createUiRuntime(engine);
    expect(bus.count()).toBe(1);

    const seen: string[] = [];
    const off = runtime.subscribe((s) => seen.push(s.devices[0]?.name ?? ''));
    bus.fire({ type: 'device.discovered', device: { deviceId: 'a', name: 'A', addr: '1.2.3.4:40001' } });
    expect(runtime.getState().devices[0].name).toBe('A');
    expect(seen).toEqual(['A']);

    off();
    bus.fire({ type: 'inbox.received', payload: { payloadId: '1' } as never });
    expect(seen).toEqual(['A']);
    expect(runtime.getState().inbox).toHaveLength(1);
  });

  // F1: the plan's own Task 2 entrypoint constructs the runtime BEFORE
  // engine.start(). A devices() issued from the constructor occupies the single
  // in-flight request slot, so Start throws 'one request at a time' and the app
  // never starts. Construction must issue nothing.
  it('issues no request on its own', async () => {
    const engine = fakeEngine();
    const devices = jest.spyOn(engine, 'devices');
    createUiRuntime(engine);
    await Promise.resolve();
    expect(devices).not.toHaveBeenCalled();
  });

  it('prime() folds a resolving devices() into state and notifies', async () => {
    const engine = fakeEngine();
    const runtime = createUiRuntime(engine);
    const seen: string[] = [];
    runtime.subscribe((s) => seen.push(s.devices.map((d) => d.name).join(',')));
    expect(runtime.getState().devices).toEqual([]);
    runtime.prime();
    // devices() is a promise, so the fold lands on a later microtask.
    await Promise.resolve();
    expect(runtime.getState().devices.map((d) => d.name)).toEqual(['Pixel 9']);
    expect(seen).toEqual(['Pixel 9']);
  });

  // F5: the host calls prime() after start(), but a pre-Start or unreachable
  // daemon rejects. prime() must never throw and must never leave an unhandled
  // rejection behind; the next prime() refills the list.
  it('prime() with a rejecting devices() is a silent no-op', async () => {
    const engine = fakeEngine();
    jest.spyOn(engine, 'devices').mockRejectedValue(new Error('engine not started'));
    const runtime = createUiRuntime(engine);
    const seen: UiState[] = [];
    runtime.subscribe((s) => seen.push(s));
    expect(() => runtime.prime()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.getState().devices).toEqual([]);
    expect(seen).toHaveLength(0);
    expect(unhandled).toEqual([]);
  });

  // F5 guard: proves the `unhandled` counter is wired to a real rejection, so
  // the F5 test above cannot pass vacuously. The rejected promise carries a
  // HANDLER (a real leak has none, which is what the runtime reports), so this
  // does not kill the worker the way a genuinely unhandled one would.
  it('sees an unhandled rejection when there is one', () => {
    const leak = new Error('leaked');
    const handled = Promise.reject(leak).catch(() => {});
    process.emit('unhandledRejection', leak, handled);
    expect(unhandled).toEqual([leak]);
    unhandled.length = 0;
  });

  // R2: NO engine puts `online` in a devices() snapshot -- daak-ffi says so in
  // a comment, daakd omits the key, the Rust DeviceInfo has no such field. And
  // discovery inserts into the SAME map devices() drains, so a device that
  // arrived via device.discovered is ALWAYS in the snapshot. The prime must
  // therefore carry that liveness across instead of stripping it.
  it('carries discovered liveness across the prime', async () => {
    const engine = fakeEngine();
    const bus = emitters(engine);
    const runtime = createUiRuntime(engine);
    // The default fake device is `aa` * 16; claim it as discovered and online.
    bus.fire({ type: 'device.discovered', device: { deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '192.168.1.9:40001', online: true } });
    runtime.prime();
    await Promise.resolve();
    const d = runtime.getState().devices[0] as DeviceInfo;
    expect(runtime.getState().devices).toHaveLength(1);
    expect(d.name).toBe('Pixel 9');
    expect(d.online).toBe(true);
  });

  // And with no event to carry from, nothing is invented.
  it('invents no liveness for a device no event ever mentioned', async () => {
    const engine = fakeEngine();
    const runtime = createUiRuntime(engine);
    runtime.prime();
    await Promise.resolve();
    const d = runtime.getState().devices[0] as DeviceInfo;
    expect(d.name).toBe('Pixel 9');
    expect(d.online).toBeUndefined();
  });

  // F2 regression: a device.discovered that beat the prime set online: true,
  // and the merge must keep it. A wholesale replace stripped it, which left the
  // composer dead on the exact path that matters.
  it('a device.discovered before prime() survives it with its liveness intact', async () => {
    const engine = fakeEngine();
    const bus = emitters(engine);
    const runtime = createUiRuntime(engine);
    bus.fire({ type: 'device.discovered', device: { deviceId: 'z', name: 'Z', addr: '9.9.9.9:1', online: true } });
    const seen: string[] = [];
    runtime.subscribe((s) => seen.push(s.devices.map((d) => d.name).join(',')));
    runtime.prime();
    await Promise.resolve();
    const z = runtime.getState().devices.find((d) => d.deviceId === 'z');
    expect(z).toBeDefined();
    expect(z?.online).toBe(true);
    // Nothing about the peer changed, so nothing was notified -- but the two
    // entries are fresh objects, so the reducer cannot prove that and does not.
    expect(runtime.getState().devices).toHaveLength(2);
    expect(seen).toEqual(['Pixel 9,Z']);
  });

  // finding 4: `transfer.item` fires once per item and its default arm returns
  // the same state object, so an unconditional notify re-rendered the whole
  // tree per file with a byte-identical snapshot.
  it('does not notify when the reducer returned the same state', () => {
    const engine = fakeEngine();
    const bus = emitters(engine);
    const runtime = createUiRuntime(engine);
    const seen: UiState[] = [];
    runtime.subscribe((s) => seen.push(s));
    bus.fire({ type: 'transfer.item', transferId: 't', itemIndex: 0, state: 'receiving' });
    bus.fire({ type: 'transfer.item', transferId: 't', itemIndex: 1, state: 'receiving' });
    expect(seen).toHaveLength(0);
    bus.fire({ type: 'inbox.received', payload: { payloadId: '1' } as never });
    expect(seen).toHaveLength(1);
  });

  // F1 fallout. The type is the API: any object typed `UiRuntime` now owes a
  // `prime`, and a test double that is missing one is not a runtime. Fails to
  // COMPILE if `prime` is ever dropped from the interface. App.test.tsx builds
  // the same object literal to count resubscribes, so it is here too.
  it('exposes prime on the UiRuntime type', () => {
    const base = createUiRuntime(fakeEngine());
    const runtime: UiRuntime = { getState: base.getState, subscribe: base.subscribe, prime: base.prime };
    expect(typeof runtime.prime).toBe('function');
  });
});
