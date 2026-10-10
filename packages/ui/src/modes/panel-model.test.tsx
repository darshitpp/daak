import type { DeviceInfo, TransferSummary } from '@daak/core';
import {
  fileLine,
  isRunning,
  isSelectable,
  newestRunningOut,
  panelDevices,
  percent,
  sendLine,
  sendViewOf,
  tail,
} from './panel-model';

const dev = (name: string, presence: DeviceInfo['presence'], paired = true): DeviceInfo => ({
  deviceId: name.toLowerCase().padEnd(32, '0'),
  name,
  addr: '',
  presence,
  online: presence !== 'offline',
  paired,
});

const row = (over: Partial<TransferSummary> = {}): TransferSummary => ({
  transferId: 'tt'.repeat(16),
  peerDeviceId: 'aa'.repeat(16),
  direction: 'out',
  kind: 'media',
  state: 'active',
  bytesDone: 0,
  bytesTotal: 0,
  itemCount: 1,
  updatedAt: 10,
  ...over,
});

describe('panelDevices', () => {
  it('returns nothing for no devices', () => {
    expect(panelDevices([])).toEqual([]);
  });

  it('keeps one device', () => {
    expect(panelDevices([dev('Solo', 'online')]).map((d) => d.name)).toEqual(['Solo']);
  });

  // Review Focus 4. Five paired devices show three rows, in the design order.
  it('shows at most 3 rows, ordered online, away, offline, then name', () => {
    const list = [dev('Zed', 'offline'), dev('Bea', 'away'), dev('Cy', 'online'), dev('Al', 'online'), dev('Di', 'offline')];
    expect(panelDevices(list).map((d) => d.name)).toEqual(['Al', 'Cy', 'Bea']);
  });

  it('shows an offline device when fewer than 3 are better', () => {
    expect(panelDevices([dev('Zed', 'offline'), dev('Al', 'online')]).map((d) => d.name)).toEqual(['Al', 'Zed']);
  });

  it('never shows a device that is not paired', () => {
    expect(panelDevices([dev('Stranger', 'online', false), dev('Friend', 'away')]).map((d) => d.name)).toEqual(['Friend']);
  });

  it('does not change the list it was given', () => {
    const list = [dev('Zed', 'offline'), dev('Al', 'online')];
    panelDevices(list);
    expect(list.map((d) => d.name)).toEqual(['Zed', 'Al']);
  });
});

describe('isSelectable', () => {
  it('allows online and away, and refuses offline', () => {
    expect(isSelectable(dev('A', 'online'))).toBe(true);
    expect(isSelectable(dev('A', 'away'))).toBe(true);
    expect(isSelectable(dev('A', 'offline'))).toBe(false);
  });

  // A daemon that predates the presence field sends none. The panel keeps its
  // old behavior and allows the row.
  it('allows a device with no presence and no online flag', () => {
    expect(isSelectable({ deviceId: 'a', name: 'Old', addr: '', paired: true })).toBe(true);
  });
});

describe('transfers', () => {
  it('knows which states are running', () => {
    for (const s of ['queued', 'active', 'paused', 'awaiting_ack']) expect(isRunning({ state: s })).toBe(true);
    for (const s of ['done', 'failed', 'canceled']) expect(isRunning({ state: s })).toBe(false);
  });

  it('picks the newest running outbound transfer', () => {
    const list = [
      row({ transferId: 'a1', updatedAt: 5 }),
      row({ transferId: 'a2', updatedAt: 9 }),
      row({ transferId: 'a3', updatedAt: 99, state: 'done' }),
      row({ transferId: 'a4', updatedAt: 99, direction: 'in' }),
    ];
    expect(newestRunningOut(list)?.transferId).toBe('a2');
    expect(newestRunningOut([])).toBeUndefined();
  });

  it('gives a percent only when both numbers are above zero', () => {
    expect(percent(0, 100)).toBeNull();
    expect(percent(50, 0)).toBeNull();
    expect(percent(50, 200)).toBe(25);
    expect(percent(300, 200)).toBe(100);
  });
});

describe('labels', () => {
  it('takes the last path segment', () => {
    expect(tail('/Users/d/Documents/a.txt')).toBe('a.txt');
    expect(tail('a.txt')).toBe('a.txt');
  });

  it('writes the file line of the design', () => {
    expect(fileLine('Q3-report.pdf', 4_400_000)).toBe('Q3-report.pdf · 4.2 MB');
    expect(fileLine('note text', 0)).toBe('note text');
  });

  it('writes the size alone for a transfer without a label', () => {
    expect(sendLine('', 4_400_000)).toBe('4.2 MB');
    expect(sendLine('', 0)).toBe('');
    expect(sendLine('a.pdf', 2048)).toBe('a.pdf · 2.0 KB');
  });
});

describe('sendViewOf', () => {
  const online = dev('Pixel', 'online');
  const offline = dev('Pixel', 'offline');
  it('maps the terminal states', () => {
    expect(sendViewOf(row({ state: 'done', bytesTotal: 9 }), online)).toEqual({ kind: 'done', total: 9 });
    expect(sendViewOf(row({ state: 'failed' }), online)).toEqual({ kind: 'failed' });
    expect(sendViewOf(row({ state: 'canceled' }), online)).toEqual({ kind: 'stopped' });
  });

  it('is waiting only for a queued transfer to an offline or unknown device', () => {
    expect(sendViewOf(row({ state: 'queued' }), offline)).toMatchObject({ kind: 'running', waiting: true });
    expect(sendViewOf(row({ state: 'queued' }), undefined)).toMatchObject({ waiting: true });
    expect(sendViewOf(row({ state: 'queued' }), online)).toMatchObject({ waiting: false });
    expect(sendViewOf(row({ state: 'queued' }), dev('P', 'away'))).toMatchObject({ waiting: false });
    expect(sendViewOf(row({ state: 'active' }), offline)).toMatchObject({ waiting: false });
  });

  it('carries the byte counts', () => {
    expect(sendViewOf(row({ state: 'active', bytesDone: 5, bytesTotal: 10 }), online)).toEqual({
      kind: 'running', waiting: false, done: 5, total: 10,
    });
  });
});
