import { describe, expect, it } from 'vitest';
import { DEFAULT_ITEM_BYTES, GIB, fits, planBatches } from './planBatches';

const MIB = 1024 * 1024;
const ref = (token: string, size: number | null) => ({ token, size });

describe('fits', () => {
  it('fits is total + 1 GiB <= free', () => {
    expect(fits(GIB, 2 * GIB - 1)).toBe(false);
    expect(fits(GIB, 2 * GIB)).toBe(true);
    expect(fits(GIB, 2 * GIB + 1)).toBe(true);
  });
});

describe('planBatches', () => {
  it('budget is min(4 GiB, free / 2) on iOS and min(4 GiB, free / 4) on Android', () => {
    // Small free: iOS budget 1 GiB, Android budget 512 MiB.
    const ios = (n: number) =>
      planBatches([ref('a', n), ref('b', 1)], { free: 2 * GIB, platform: 'ios' });
    expect(ios(GIB - 1).map((b) => b.tokens)).toEqual([['a', 'b']]);
    expect(ios(GIB).map((b) => b.tokens)).toEqual([['a'], ['b']]);
    const and = (n: number) =>
      planBatches([ref('a', n), ref('b', 1)], { free: 2 * GIB, platform: 'android' });
    expect(and(512 * MIB - 1).map((b) => b.tokens)).toEqual([['a', 'b']]);
    expect(and(512 * MIB).map((b) => b.tokens)).toEqual([['a'], ['b']]);
    // Huge free: the 4 GiB cap applies to both platforms.
    for (const platform of ['ios', 'android'] as const) {
      const big = (n: number) =>
        planBatches([ref('a', n), ref('b', 1)], { free: 100 * GIB, platform });
      expect(big(4 * GIB - 1).map((b) => b.tokens)).toEqual([['a', 'b']]);
      expect(big(4 * GIB).map((b) => b.tokens)).toEqual([['a'], ['b']]);
    }
  });

  it('items keep the pick order', () => {
    const refs = ['c', 'a', 'd', 'b'].map((t) => ref(t, 400 * MIB));
    const out = planBatches(refs, { free: 2 * GIB, platform: 'ios' });
    expect(out.flatMap((b) => b.tokens)).toEqual(['c', 'a', 'd', 'b']);
    expect(out.map((b) => b.tokens)).toEqual([['c', 'a'], ['d', 'b']]);
  });

  it('one item larger than the budget makes a batch of its own and the other items still batch around it', () => {
    const refs = [ref('a', 300 * MIB), ref('big', 3 * GIB), ref('b', 300 * MIB), ref('c', 300 * MIB)];
    const out = planBatches(refs, { free: 2 * GIB, platform: 'ios' });
    expect(out.map((b) => b.tokens)).toEqual([['a'], ['big'], ['b', 'c']]);
    expect(out[1].bytes).toBe(3 * GIB);
  });

  it('an unknown size counts as 64 MiB', () => {
    expect(DEFAULT_ITEM_BYTES).toBe(64 * MIB);
    const out = planBatches([ref('a', null), ref('b', null)], { free: 2 * GIB, platform: 'ios' });
    expect(out).toEqual([{ index: 1, of: 1, tokens: ['a', 'b'], bytes: 128 * MIB }]);
    // 16 unknown items fill 1 GiB exactly. The 17th starts a new batch.
    const many = Array.from({ length: 17 }, (_, i) => ref(`t${i}`, null));
    const split = planBatches(many, { free: 2 * GIB, platform: 'ios' });
    expect(split.map((b) => b.tokens.length)).toEqual([16, 1]);
  });

  it('an empty selection gives no batch', () => {
    expect(planBatches([], { free: 10 * GIB, platform: 'android' })).toEqual([]);
  });

  it('index and of are 1-based and consistent', () => {
    const refs = Array.from({ length: 5 }, (_, i) => ref(`t${i}`, GIB));
    const out = planBatches(refs, { free: 2 * GIB, platform: 'ios' });
    expect(out.map((b) => b.index)).toEqual([1, 2, 3, 4, 5]);
    expect(out.every((b) => b.of === 5)).toBe(true);
  });

  it('a selection that would need more than 1000 batches throws PLAN_TOO_LARGE', () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => ref(`t${i}`, GIB));
    expect(planBatches(make(1000), { free: 2 * GIB, platform: 'ios' })).toHaveLength(1000);
    expect(() => planBatches(make(1001), { free: 2 * GIB, platform: 'ios' })).toThrow(
      /^PLAN_TOO_LARGE/,
    );
  });

  it('free of 0 throws a NO_SPACE error', () => {
    const refs = [ref('a', 1)];
    expect(() => planBatches(refs, { free: 0, platform: 'ios' })).toThrow(/^NO_SPACE/);
    expect(() => planBatches(refs, { free: -1, platform: 'android' })).toThrow(/^NO_SPACE/);
    expect(() => planBatches(refs, { free: NaN, platform: 'ios' })).toThrow(/^NO_SPACE/);
  });

  it('the input array is not changed', () => {
    const refs = [ref('a', 5), ref('b', null)];
    const copy = JSON.parse(JSON.stringify(refs));
    planBatches(refs, { free: 2 * GIB, platform: 'ios' });
    expect(refs).toEqual(copy);
  });
});
