import { describe, expect, it } from 'vitest';
import { normalizeShareItems } from '../js/items';

describe('normalizeShareItems', () => {
  it('keeps file order and dedupes repeats', () => {
    const payload = normalizeShareItems({ files: ['/a.txt', '/b.txt', '/a.txt'] });
    expect(payload.paths).toEqual(['/a.txt', '/b.txt']);
  });

  it('drops blank paths and trims text', () => {
    const payload = normalizeShareItems({ text: '  hi  ', files: ['', '  '] });
    expect(payload.paths).toEqual([]);
    expect(payload.text).toBe('hi');
  });

  it('omits text when only files are present', () => {
    const payload = normalizeShareItems({ files: ['/a.txt'] });
    expect(payload.text).toBeUndefined();
    expect(payload.paths).toEqual(['/a.txt']);
  });
});
