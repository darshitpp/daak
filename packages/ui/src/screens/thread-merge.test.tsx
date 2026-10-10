import { threadItem, threadPage } from '../testing/threadFixtures';
import { EMPTY_THREAD, itemKey, mergeThread, prependOlder } from './thread-merge';

const it1 = (n: number) => threadItem({ transferId: String(n).padStart(2, '0').repeat(16), at: 1000 + n });

describe('mergeThread', () => {
  it('takes the first page as is', () => {
    const page = threadPage([it1(1), it1(2)], 'c1');
    expect(mergeThread(EMPTY_THREAD, page)).toEqual({ items: page.items, olderCursor: 'c1' });
  });

  // A new transfer arrives. The newest page now overlaps the loaded items.
  it('keeps older loaded items and the older cursor when the new page overlaps', () => {
    const prev = { items: [it1(1), it1(2), it1(3)], olderCursor: 'deep' };
    const next = threadPage([it1(3), it1(4)], 'shallow');
    const merged = mergeThread(prev, next);
    expect(merged.items.map(itemKey)).toEqual([it1(1), it1(2), it1(3), it1(4)].map(itemKey));
    expect(merged.olderCursor).toBe('deep');
  });

  // The newest page moved up by 50 transfers. Keeping the old pages would leave a gap.
  it('drops the old pages when the new page does not touch them', () => {
    const prev = { items: [it1(1), it1(2)], olderCursor: 'deep' };
    const next = threadPage([it1(60), it1(61)], 'cur60');
    expect(mergeThread(prev, next)).toEqual({ items: next.items, olderCursor: 'cur60' });
  });

  it('lets the new copy of an item replace the old copy', () => {
    const old = { ...it1(3), state: 'receiving' as const };
    const fresh = { ...it1(3), state: 'done' as const };
    const merged = mergeThread({ items: [it1(2), old], olderCursor: null }, threadPage([fresh]));
    expect(merged.items[1].state).toBe('done');
  });

  it('shows an empty thread when the page is empty', () => {
    expect(mergeThread({ items: [it1(1)], olderCursor: 'x' }, threadPage([]))).toEqual({ items: [], olderCursor: null });
  });
});

describe('prependOlder', () => {
  it('puts the older page first and takes its cursor', () => {
    const merged = prependOlder({ items: [it1(5)], olderCursor: 'c5' }, threadPage([it1(3), it1(4)], null));
    expect(merged.items.map(itemKey)).toEqual([it1(3), it1(4), it1(5)].map(itemKey));
    expect(merged.olderCursor).toBeNull();
  });
  it('drops an item that is already loaded', () => {
    const merged = prependOlder({ items: [it1(4), it1(5)], olderCursor: 'c' }, threadPage([it1(3), it1(4)], 'd'));
    expect(merged.items.map(itemKey)).toEqual([it1(3), it1(4), it1(5)].map(itemKey));
  });
});

