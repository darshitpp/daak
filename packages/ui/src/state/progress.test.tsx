import { itemPercents } from './progress';

type It = { itemIndex: number; size: number | null; truncated?: boolean };
const mk = (sizes: (number | null)[]): It[] => sizes.map((size, itemIndex) => ({ itemIndex, size }));
const arr = (m: Map<number, number> | null) => (m ? [...m.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]) : null);

describe('itemPercents', () => {
  it('three files of 100, bytesDone 50: 50, 0, 0', () => {
    expect(arr(itemPercents(mk([100, 100, 100]), 50))).toEqual([50, 0, 0]);
  });
  it('bytesDone 150: 100, 50, 0', () => {
    expect(arr(itemPercents(mk([100, 100, 100]), 150))).toEqual([100, 50, 0]);
  });
  it('bytesDone above the sum: all 100', () => {
    expect(arr(itemPercents(mk([100, 100, 100]), 9999))).toEqual([100, 100, 100]);
  });
  it('size null counts as 0 bytes and never gives NaN', () => {
    const r = itemPercents(mk([null, 100]), 50);
    expect(arr(r)).toEqual([100, 50]);
    expect(arr(itemPercents(mk([null, null]), 0))).toEqual([0, 0]);
    for (const v of r!.values()) expect(Number.isNaN(v)).toBe(false);
  });
  it('a size 0 item is 100 only when the offset is below bytesDone', () => {
    expect(arr(itemPercents(mk([100, 0, 100]), 100))).toEqual([100, 0, 0]);
    expect(arr(itemPercents(mk([100, 0, 100]), 101))).toEqual([100, 100, 1]);
  });
  it('unsorted input gives the sorted result', () => {
    const items: It[] = [
      { itemIndex: 2, size: 100 },
      { itemIndex: 0, size: 100 },
      { itemIndex: 1, size: 100 },
    ];
    const copy = items.map((i) => ({ ...i }));
    const r = itemPercents(items, 150);
    expect(r!.get(0)).toBe(100);
    expect(r!.get(1)).toBe(50);
    expect(r!.get(2)).toBe(0);
    expect(items).toEqual(copy);
  });
  it('a cut list returns null', () => {
    const items = mk([100, 100]);
    items[1].truncated = true;
    expect(itemPercents(items, 50)).toBeNull();
  });
  it('an empty list returns null', () => {
    expect(itemPercents([], 10)).toBeNull();
  });
  it('all items in state receiving still get percents from bytes', () => {
    const items = mk([100, 100]).map((i) => ({ ...i, state: 'receiving' }));
    expect(arr(itemPercents(items, 100))).toEqual([100, 0]);
  });
  it('a size of 100 at 29 bytes gives 29 percent', () => {
    for (const n of [29, 57, 58]) expect(arr(itemPercents(mk([100]), n))).toEqual([n]);
  });
  it('a negative size does not shift later offsets back', () => {
    expect(arr(itemPercents(mk([-50, 100]), 50))).toEqual([100, 50]);
  });
  it('a null size in the middle keeps the offsets right', () => {
    expect(arr(itemPercents(mk([100, null, 100]), 150))).toEqual([100, 100, 50]);
  });
  it('a negative bytesDone gives 0 for every item', () => {
    expect(arr(itemPercents(mk([100, 0, null, 50]), -10))).toEqual([0, 0, 0, 0]);
  });
});
