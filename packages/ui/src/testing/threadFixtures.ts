import type { ThreadItem, ThreadPage } from '@daak/core';

/** A text item the peer sent. Override any field. */
export function threadItem(p: Partial<ThreadItem> = {}): ThreadItem {
  return {
    transferId: 'bb'.repeat(16),
    itemIndex: 0,
    direction: 'in',
    type: 'text',
    name: null,
    size: null,
    text: 'hello',
    state: 'done',
    destPath: null,
    at: 1_700_000_000,
    transferState: 'done',
    error: null,
    ...p,
  };
}

export function threadPage(items: ThreadItem[], olderCursor: string | null = null): ThreadPage {
  return { items, olderCursor };
}

