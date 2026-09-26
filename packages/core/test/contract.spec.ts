import { describe, expect, it } from 'vitest';
import type { DaakEngine, DaakEvent, DeviceInfo } from '../src/engine/types';

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

  it('models a device without fabricating liveness (R11)', () => {
    const discovered: DeviceInfo = { deviceId: 'd1', name: 'peer', addr: '10.0.0.2:9000' };
    expect(discovered.online).toBeUndefined();
  });
});
