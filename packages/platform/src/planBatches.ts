// Split a large photo or video selection into batches. The app then needs
// only one batch of copies on disk at a time. This module is pure. It has no
// native code and no I/O.

export const GIB = 1024 ** 3;
/** Size that counts for an item with an unknown size. */
export const DEFAULT_ITEM_BYTES = 64 * 1024 * 1024;
const MAX_BATCHES = 1000;

export type BatchRef = { token: string; size: number | null };
export type Batch = { index: number; of: number; tokens: string[]; bytes: number };

/** True when the total size plus 1 GiB of spare room fits in the free space. */
export function fits(totalBytes: number, free: number): boolean {
  return totalBytes + GIB <= free;
}

export function planBatches(
  refs: BatchRef[],
  opts: { free: number; platform: 'android' | 'ios' },
): Batch[] {
  const { free, platform } = opts;
  if (!Number.isFinite(free) || free <= 0) throw new Error('NO_SPACE: no free space');
  // Android counts the staged copy, because a hard link is denied there.
  const budget = Math.min(4 * GIB, free / (platform === 'ios' ? 2 : 4));
  const batches: Array<{ tokens: string[]; bytes: number }> = [];
  let cur: { tokens: string[]; bytes: number } | null = null;
  for (const r of refs) {
    const size = r.size ?? DEFAULT_ITEM_BYTES;
    if (cur === null || cur.bytes + size > budget) {
      cur = { tokens: [], bytes: 0 };
      batches.push(cur);
    }
    cur.tokens.push(r.token);
    cur.bytes += size;
  }
  if (batches.length > MAX_BATCHES) {
    throw new Error(`PLAN_TOO_LARGE: ${batches.length} batches, the limit is ${MAX_BATCHES}`);
  }
  return batches.map((b, i) => ({ index: i + 1, of: batches.length, ...b }));
}
