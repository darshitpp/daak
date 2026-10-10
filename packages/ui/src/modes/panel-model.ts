import type { DeviceInfo, TransferSummary } from '@daak/core';
import { byPresence, presenceOf } from '../components/ds';
import { humanBytes } from '../screens/quarantine-facts';

/** The design shows at most 3 devices. A fourth device is reachable in the full app. */
export const PANEL_MAX_DEVICES = 3;

// The `transfers.state` values that mean "not finished" (`store/transfers.rs`).
const RUNNING = new Set(['queued', 'active', 'paused', 'awaiting_ack']);

/**
 * The rows of the panel. A device that is not paired cannot receive a send, so
 * it never shows. The order is online, away, offline, then the name.
 */
export function panelDevices(devices: DeviceInfo[]): DeviceInfo[] {
  return devices
    .filter((d) => d.paired === true)
    .sort(byPresence)
    .slice(0, PANEL_MAX_DEVICES);
}

/**
 * An offline row shows but the user cannot choose it (design: `aria-disabled`).
 * The engine does queue a send to an offline device, and the thread allows it.
 * The panel is the quick path and follows the design.
 */
export function isSelectable(d: DeviceInfo): boolean {
  return presenceOf(d).rank !== 2;
}

export function isRunning(t: Pick<TransferSummary, 'state'>): boolean {
  return RUNNING.has(t.state);
}

/** The transfer that the panel adopts when it did not start one itself. */
export function newestRunningOut(transfers: TransferSummary[]): TransferSummary | undefined {
  let best: TransferSummary | undefined;
  for (const t of transfers) {
    if (t.direction !== 'out' || !isRunning(t)) continue;
    if (best === undefined || t.updatedAt > best.updatedAt) best = t;
  }
  return best;
}

/** A percent, or null while a number is unknown. The panel must not show a false 0%. */
export function percent(done: number, total: number): number | null {
  return done > 0 && total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : null;
}

/** The last segment of a path: what a person recognises a file by. */
export function tail(path: string): string {
  return path.split('/').pop() || path;
}

export function fileLine(name: string, bytes: number): string {
  return bytes > 0 ? `${name} · ${humanBytes(bytes)}` : name;
}

/**
 * The line under "Sending to {name}". A transfer that the panel adopted has no
 * label, so the line then holds the size alone, or nothing.
 */
export function sendLine(label: string, bytes: number): string {
  if (label === '') return bytes > 0 ? humanBytes(bytes) : '';
  return fileLine(label, bytes);
}

export type SendView =
  | { kind: 'running'; waiting: boolean; done: number; total: number }
  | { kind: 'done'; total: number }
  | { kind: 'failed' }
  | { kind: 'stopped' };

/**
 * What the panel shows for a transfer row. `waiting` is true for a queued
 * transfer to a device that is offline or unknown. An away device still receives
 * and holds the item, so it is not waiting.
 */
export function sendViewOf(row: TransferSummary, peer: DeviceInfo | undefined): SendView {
  if (row.state === 'done') return { kind: 'done', total: row.bytesTotal };
  if (row.state === 'failed') return { kind: 'failed' };
  if (row.state === 'canceled') return { kind: 'stopped' };
  const offline = peer === undefined || presenceOf(peer).rank === 2;
  return {
    kind: 'running',
    waiting: row.state === 'queued' && offline,
    done: row.bytesDone,
    total: row.bytesTotal,
  };
}
