import { readFileSync } from 'fs';
import { join } from 'path';

// No Xcode, no swiftc on this host, so this is a SOURCE-LEVEL pin, not a
// behavioural test -- the same discipline qrScanner.test.ts and
// nativeStoreAndPaths.test.ts already hold over the sibling native files.
//
// SCOPE, deliberately narrow: this pins ONLY the method this change adds. The
// previous version also asserted the trailing-`nil` shape of cancel, retry,
// setPresence and setDisplayName, which are unrelated to the host arm and would
// fail this suite -- and the pairing commit -- for reasons that have nothing to
// do with it. Those methods are the file's existing convention, not this
// change's contract.
//
// Why the trailing nil is load-bearing: `run` is
//   private func run<T>(..., _ block: () throws -> T?)
// and for a Void-returning UDL method a single-expression closure
// `{ try self.need().armHostPairing() }` leaves T ambiguous (Void? vs T?), so
// it does not type-check. Omitting the nil is a BUILD BREAK, not a runtime bug,
// which is why nothing else in the suite would ever see it.
describe('apps/mobile/ios/Daak.swift armHostPairing', () => {
  const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');
  const swift = read('../../ios/Daak.swift');

  it('is declared for the UDL method, taking no bundle', () => {
    expect(swift).toMatch(/@objc func armHostPairing\(/);
    // No bundle parameter: the host has none. A bundle argument here would
    // mean the unreachable host-side scan crept back into the native layer.
    expect(swift).not.toMatch(/@objc func armHostPairing\(_ bundleCbor/);
  });

  // Both Void UDL methods on the pairing surface need the trailing nil, and
  // BOTH were previously unpinned: the old slice started at armHostPairing and
  // ran forward to acceptPairing, so offerPairing -- which sits ABOVE it -- was
  // never reached and the suite stayed green with its nil deleted. Each case
  // below now slices its own method body.
  it.each([
    ['offerPairing', 'offerPairing(bundleCbor: bytes)', 'func armHostPairing('],
    ['armHostPairing', 'armHostPairing()', 'func acceptPairing('],
  ])('%s returns the trailing nil so the generic Void closure type-checks',
    (_name, call, nextFn) => {
      const start = swift.indexOf(`func ${_name}(`);
      expect(start).toBeGreaterThan(-1);
      const end = swift.indexOf(nextFn, start);
      expect(end).toBeGreaterThan(start);
      const body = swift.slice(start, end);
      expect(body).toMatch(new RegExp(`${call.replace(/[()]/g, '\\$&')};\\s*return nil`));
    });
});
