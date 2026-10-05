import type { QuarantineReport } from '@daak/core';

/**
 * The one place that turns a QuarantineReport's optional fields into text.
 *
 * Shared, not duplicated, because the Inbox list row and the "Held back"
 * detail are two views of the SAME record: if the list says "Device aabbccdd"
 * and the detail says "Not recorded", the app is contradicting itself on the
 * one subject where it is asking for trust. Every helper here is also
 * deliberately incapable of inventing a value -- see the NOT_RECORDED
 * branches.
 */
export const NOT_RECORDED = 'Not recorded';

/**
 * A paired label when one exists, else the device id prefix, else nothing.
 *
 * The id prefix is a REAL identifier from the transfer row, so "Device
 * aabbccdd" is a fact. It is not a display name, which is why it is prefixed
 * with "Device" rather than shown bare -- and why nothing at all is invented
 * when even the id is missing.
 */
export function senderLabel(r: Pick<QuarantineReport, 'senderName' | 'senderDeviceId'>): string {
  if (r.senderName !== null && r.senderName !== '') return r.senderName;
  if (r.senderDeviceId !== null && r.senderDeviceId !== '') return 'Device ' + r.senderDeviceId.slice(0, 8);
  return NOT_RECORDED;
}

/**
 * The prototype groups its sample as three groups of FOUR hex chars -- not
 * three groups of two bytes. Rendered from the real hash; a short hash is shown
 * whole rather than padded, because padding invents bytes.
 */
export function fingerprintGroups(hash: string): string {
  const h = hash.replace(/[^0-9a-f]/gi, '').toLowerCase();
  const out: string[] = [];
  for (let i = 0; i < Math.min(h.length, 12); i += 4) out.push(h.slice(i, i + 4));
  return out.join(' ');
}

/** Binary units, because that is what the sender's manifest actually counts. */
export function humanBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

/**
 * Absolute time, not a relative "2 minutes ago". A held-back file can sit here
 * for days before anyone looks at it, and a relative time would quietly
 * re-base itself against a moment the user is not reading it.
 */
export function arrivedAt(seconds: number): string {
  const d = new Date(seconds * 1000);
  return Number.isNaN(d.getTime()) ? NOT_RECORDED : d.toLocaleString();
}
