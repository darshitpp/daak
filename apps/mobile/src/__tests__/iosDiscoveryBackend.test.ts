import { readFileSync } from 'fs';
import { join } from 'path';

// SOURCE PIN. The iOS target has no test run on this host. This pin keeps the
// iOS build on the system-Bonjour backend. Raw multicast needs a restricted
// entitlement that a free Apple ID profile cannot carry (ledger C7, C8).
describe('daak-core discovery backend selection', () => {
  const mod = readFileSync(
    join(__dirname, '../../../../crates/daak-core/src/discovery/mod.rs'),
    'utf8',
  );

  it('re-exports Advertiser and Browser from dnssd on iOS', () => {
    expect(mod).toMatch(
      /#\[cfg\(target_os = "ios"\)\]\s*pub use dnssd::\{Advertiser, Browser\};/,
    );
  });

  it('re-exports Advertiser and Browser from mdns everywhere else', () => {
    expect(mod).toMatch(
      /#\[cfg\(not\(target_os = "ios"\)\)\]\s*pub use mdns::\{Advertiser, Browser\};/,
    );
  });

  it('does not export Advertiser or Browser from mdns without a cfg', () => {
    // Remove the line that the non-iOS cfg guards. No other line may name them.
    const ungated = mod.replace(
      /#\[cfg\(not\(target_os = "ios"\)\)\]\s*pub use mdns::\{Advertiser, Browser\};/,
      '',
    );
    expect(ungated).not.toMatch(/pub use mdns::\{[^}]*\b(Advertiser|Browser)\b[^}]*\};/);
  });
});
