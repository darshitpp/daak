import type { ThreadItem, ThreadPage } from '@daak/core';

export interface ThreadView {
  items: ThreadItem[];
  olderCursor: string | null;
}

export const EMPTY_THREAD: ThreadView = { items: [], olderCursor: null };

export const itemKey = (i: Pick<ThreadItem, 'transferId' | 'itemIndex'>): string => `${i.transferId}:${i.itemIndex}`;

/**
 * Fold a fresh newest page into what is loaded. The page is oldest first.
 * Everything in the page is current. Loaded items before the first overlap are
 * older than the page and stay. When the page overlaps nothing, a gap may
 * exist between it and the loaded items, so the old pages go. The user can
 * scroll up to load them again.
 */
export function mergeThread(prev: ThreadView, next: ThreadPage): ThreadView {
  if (prev.items.length === 0) return { items: next.items, olderCursor: next.olderCursor };
  const fresh = new Set(next.items.map(itemKey));
  const at = prev.items.findIndex((i) => fresh.has(itemKey(i)));
  if (at === -1) return { items: next.items, olderCursor: next.olderCursor };
  return { items: [...prev.items.slice(0, at), ...next.items], olderCursor: prev.olderCursor };
}

/** Put an older page in front. An item that is already loaded keeps its place. */
export function prependOlder(prev: ThreadView, older: ThreadPage): ThreadView {
  const have = new Set(prev.items.map(itemKey));
  const add = older.items.filter((i) => !have.has(itemKey(i)));
  return { items: [...add, ...prev.items], olderCursor: older.olderCursor };
}

