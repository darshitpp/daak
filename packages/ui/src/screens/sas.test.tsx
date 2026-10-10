import { formatSas } from './sas';

describe('formatSas', () => {
  it('writes 6 digits as 2 groups of 3', () => {
    expect(formatSas('482917')).toBe('482 917');
  });

  // The engine formats the number with {n:06}. A small number has leading zeros.
  // A leading zero is part of the number the user reads out loud.
  it('keeps leading zeros', () => {
    expect(formatSas('004217')).toBe('004 217');
    expect(formatSas('000000')).toBe('000 000');
    expect(formatSas('000001')).toBe('000 001');
  });

  it('does not change a number that already has the space', () => {
    expect(formatSas('482 917')).toBe('482 917');
  });

  // A value that is not 6 digits is not a SAS this build knows how to group.
  // Showing it as received is safer than inventing a grouping.
  it('returns a value that is not 6 digits as received', () => {
    expect(formatSas('12345')).toBe('12345');
    expect(formatSas('1234567')).toBe('1234567');
    expect(formatSas('12a456')).toBe('12a456');
    expect(formatSas('')).toBe('');
  });
});

