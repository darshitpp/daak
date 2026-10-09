import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// The shipped macOS app makes no HTTP request. Metro runs on localhost, and the
// localhost exception covers it. A global NSAllowsArbitraryLoads would allow
// cleartext HTTP to every host.
const plist = readFileSync(
  join(__dirname, '..', 'macos', 'Daak-macOS', 'Info.plist'),
  'utf8',
);

describe('the macOS App Transport Security setting', () => {
  it('does not allow arbitrary loads', () => {
    expect(plist).not.toMatch(/<key>NSAllowsArbitraryLoads<\/key>\s*<true\/>/);
  });

  it('keeps the localhost exception for Metro', () => {
    expect(plist).toMatch(/<key>localhost<\/key>/);
  });
});
