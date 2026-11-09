import type { ThreadItem } from '@daak/core';

type Part = Pick<ThreadItem, 'itemIndex' | 'size' | 'truncated'>;

/**
 * The percent of each file in ONE transfer, from the bytes done.
 * The key is `itemIndex`. Each value is an integer from 0 to 100.
 * Returns null when the list is empty or the list was cut.
 */
export function itemPercents(items: Part[], bytesDone: number): Map<number, number> | null {
  if (items.length === 0 || items.some((i) => i.truncated === true)) return null;
  const sorted = [...items].sort((a, b) => a.itemIndex - b.itemIndex);
  const done = Number.isFinite(bytesDone) ? bytesDone : 0;
  const out = new Map<number, number>();
  let offset = 0;
  for (const item of sorted) {
    const size = item.size ?? 0;
    let pct: number;
    if (size <= 0) pct = done > offset ? 100 : 0;
    else pct = Math.min(100, Math.max(0, Math.floor(((done - offset) * 100) / size)));
    out.set(item.itemIndex, pct);
    offset += Math.max(0, size);
  }
  return out;
}
