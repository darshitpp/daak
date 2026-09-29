import { describe, expect, it } from 'vitest';
import { buildTrayMenu } from '../js/menu';

// `online` is OPTIONAL on DeviceInfo. DaemonClient.devices() parses the
// `Devices` snapshot with parseArray and never sets it, so a cold daemon hands
// us every peer with `online === undefined`.
const device = (deviceId: string, name: string, online?: boolean) =>
  ({ deviceId, name, addr: '192.168.1.9:40001', ...(online === undefined ? {} : { online }) });

const transfer = (transferId: string, state: 'active' | 'done' | 'failed') =>
  ({ transferId, bytesDone: 1, bytesTotal: 2, state });

describe('buildTrayMenu', () => {
  it('lists every known device, one send item each, regardless of liveness', () => {
    const items = buildTrayMenu(
      [device('a', 'Alice', true), device('b', 'Bob'), device('c', 'Cara', false)],
      [],
    );
    const sends = items.filter((i) => i.id.startsWith('send:'));
    expect(sends.map((i) => i.id)).toEqual(['send:a', 'send:b', 'send:c']);
    expect(sends[0].label).toBe('Send to Alice');
    expect(sends[0].enabled).toBe(true);
  });

  it('summarises active transfers and always ends with quit', () => {
    const items = buildTrayMenu([], [transfer('t1', 'active'), transfer('t2', 'done')]);
    expect(items.some((i) => i.id === 'transfer:t1')).toBe(true);
    expect(items.some((i) => i.id === 'transfer:t2')).toBe(false);
    expect(items[items.length - 1]).toMatchObject({ id: 'quit', label: 'Quit Daak' });
  });

  it('puts separators before the transfers and quit groups', () => {
    const items = buildTrayMenu([device('a', 'Alice', true)], [transfer('t1', 'active')]);
    expect(items.filter((i) => i.separatorBefore).map((i) => i.id)).toEqual(['transfer:t1', 'quit']);
  });
});
