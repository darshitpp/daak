import { humanBytes } from './quarantine-facts';

describe('humanBytes', () => {
  it('names a size in binary units', () => {
    expect(humanBytes(512)).toBe('512 B');
    expect(humanBytes(2048)).toBe('2.0 KB');
    expect(humanBytes(4_404_019)).toBe('4.2 MB');
  });

  // A total of 0 is no size, not "0 B". The callers that guard on `bytes > 0`
  // already drop the line; the two that do not (ThreadScreen, CantReachScreen)
  // showed "0 B" for a transfer whose size the engine has not measured yet.
  it('shows no byte total when the total is 0', () => {
    expect(humanBytes(0)).toBe('');
  });
});
