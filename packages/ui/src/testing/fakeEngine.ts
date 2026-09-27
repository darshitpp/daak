import type { DaakEngine, DaakEvent, DeviceInfo } from '@daak/core';

export function fakeEngine(devices: DeviceInfo[] = [
  { deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '192.168.1.9:40001', online: true },
]): DaakEngine {
  const handlers = new Set<(e: DaakEvent) => void>();
  return {
    start: async () => {},
    stop: async () => {},
    devices: async () => devices,
    pair: async () => ({ sas: '123456' }),
    send: async () => ({ transferId: 'aa'.repeat(16), queued: true }),
    cancel: async () => {},
    retry: async () => {},
    listTransfers: async () => [],
    listInbox: async () => [],
    setDisplayName: async () => {},
    setPresence: async () => {},
    on: (cb) => {
      handlers.add(cb);
      return () => handlers.delete(cb);
    },
  };
}
