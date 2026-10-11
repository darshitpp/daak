import type { DaakEngine, DaakEvent, DeviceInfo, QuarantineReport } from '@daak/core';

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
    // PARKED, and nothing in the UI calls it -- the fake implements it only
    // because DaakEngine requires it. A fake that THREW here would be a trap
    // for the test that eventually wires it up.
    retryItem: async () => {},
    // The quarantine READS. Empty is the honest answer for a fake with no
    // engine behind it, and it is the same answer a real device with nothing
    // held gives -- which is what makes the empty state testable.
    listQuarantineReports: async () => [] as QuarantineReport[],
    // A real held item, so a test can drive the screen without a live engine.
    // The two fingerprints DIFFER by one bit, which is the entire premise of
    // the screen; a fixture where they matched would render a screen that
    // contradicts itself.
    quarantineReport: async (transferId: string, itemIndex: number): Promise<QuarantineReport> => ({
      transferId,
      itemIndex,
      name: 'harbor-lighthouse.jpg',
      size: 4_400_000,
      senderName: 'Kitchen Tablet',
      senderDeviceId: 'bb'.repeat(16),
      receivedAt: 1_700_000_000,
      expected: '7f3a91c204be' + '0'.repeat(52),
      actual: '7f3a91c204c9' + '0'.repeat(52),
      heldPath: '/tmp/daak/quarantine/harbor-lighthouse.jpg',
    }),
    deleteQuarantined: async () => {},
    listTransfers: async () => [],
    listInbox: async () => [],
    listThread: async () => ({ items: [], olderCursor: null }),
    getItemText: async () => '',
    // A real shape, not a placeholder: Settings PREFILLS its name box from
    // this, and onboarding needs the device id. A test that must prove the
    // prefills spy on this.
    selfProfile: async () => ({
      name: 'Test Device',
      // The fake has no LAN, so no collision resolves and the base name equals
      // the advertised one. A test that needs a prefix overrides this pair.
      baseName: 'Test Device',
      deviceId: 'dd'.repeat(16),
    }),
    setDisplayName: async () => {},
    setPresence: async () => {},
    revokePairing: async () => {},
    confirmPairing: async () => {},
    // A no-op is the honest fake: the wake only pokes an outbox drain the
    // fake does not have, so it can neither fail nor prove anything.
    backgroundWake: async () => {},
    replaceInboxPaths: async () => {},
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
