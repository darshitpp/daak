import { describe, expect, it } from 'vitest';
import type { DaakEngine, DaakEvent, DeviceInfo } from '../src/engine/types';

const METHODS: (keyof DaakEngine)[] = [
  'start', 'stop', 'devices', 'pair', 'send', 'cancel',
  'retry', 'listTransfers', 'listInbox', 'setDisplayName', 'setPresence', 'on',
];

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
    // Compile-time: METHODS must be exhaustive and free of typos.
    const exhaustive: Record<keyof DaakEngine, true> = {
      start: true, stop: true, devices: true, pair: true, send: true, cancel: true,
      retry: true, listTransfers: true, listInbox: true, setDisplayName: true,
      setPresence: true, on: true,
    };
    // Run-time: no method was added or removed without updating this guard.
    expect(Object.keys(exhaustive).sort()).toEqual([...METHODS].sort());
  });

  it('models a device without fabricating liveness (R11)', () => {
    const discovered: DeviceInfo = { deviceId: 'd1', name: 'peer', addr: '10.0.0.2:9000' };
    expect(discovered.online).toBeUndefined();
  });
});
