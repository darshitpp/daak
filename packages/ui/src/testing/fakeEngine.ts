import type { DaakEngine, DaakEvent, DeviceInfo } from '@daak/core';

export function fakeEngine(devices: DeviceInfo[] = [
  // No `online`: NO engine puts one there. daak-ffi omits it deliberately, daakd
  // omits the key, and the Rust DeviceInfo has no such field. A test that needs
  // an online peer passes one in explicitly.
  { deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '192.168.1.9:40001' },
]): DaakEngine {
  const handlers = new Set<(e: DaakEvent) => void>();
  const engine = {
    start: async () => {},
    stop: async () => {},
    devices: async () => devices,
    pair: async () => ({ sas: '123456' }),
    // C2: the host arm. A no-op is the honest fake: arming is local engine
    // state with no reply, so the fake can neither fail nor prove anything.
    offerPairing: async () => {},
    // Spec 3.3 Mode A host arm. A no-op is the honest fake: arming is local
    // engine state with no reply, so the fake can neither fail nor prove
    // anything. What matters to a caller is that it takes NO argument.
    armHostPairing: async () => {},
    send: async () => ({ transferId: 'aa'.repeat(16), queued: true }),
    cancel: async () => {},
    retry: async () => {},
    listTransfers: async () => [],
    listInbox: async () => [],
    setDisplayName: async () => {},
    setPresence: async () => {},
    on: (cb: (e: DaakEvent) => void) => {
      handlers.add(cb);
      return () => handlers.delete(cb);
    },
  };
  // Exposed so a test can drive an event through the LIVE handlers. The
  // subscription count is the invariant: a second engine.on in app code is
  // exactly the defect that would double-post per event, and counting real
  // registrations catches it where asserting on a mock would not.
  (engine as unknown as { __handlers: typeof handlers }).__handlers = handlers;
  return engine;
}
