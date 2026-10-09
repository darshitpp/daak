import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// On 2026-10-05 the macOS app refused to build:
//
//   "Daak-macOS" has entitlements that require signing with a development
//   certificate. Enable development signing in the Signing & Capabilities editor.
//
// Both app targets set CODE_SIGN_ENTITLEMENTS but never set a team. Xcode has
// no DEVELOPMENT_TEAM for the target, so it falls back to an ad-hoc signature,
// and an ad-hoc signature grants none of the requested groups. Such a build
// starts, then fails at the first keychain write with errSecMissingEntitlement.
// The app reports that as "keychain write failed" and "the engine did not
// start".
//
// The fix is one setting per configuration. A certificate and a provisioning
// profile already exist on this host, so the build must be able to use them.
const pbxproj = join(
  __dirname,
  '..',
  'macos',
  'Daak.xcodeproj',
  'project.pbxproj',
);

describe('the macOS targets declare a signing team', () => {
  const source = readFileSync(pbxproj, 'utf8');

  // Every block that requests a group must also name a team. A block with
  // entitlements and no team signs ad-hoc, and ad-hoc grants no group, so the
  // first keychain write fails with errSecMissingEntitlement.
  const signingBlocks = source
    .split('isa = XCBuildConfiguration;')
    .slice(1)
    .filter((block) => block.includes('CODE_SIGN_ENTITLEMENTS'));

  it('reads at least one configuration that requests entitlements', () => {
    expect(signingBlocks.length).toBe(4);
  });

  it('names a team in every configuration that requests entitlements', () => {
    const nameless = signingBlocks.filter(
      (block) => !/DEVELOPMENT_TEAM = J6NNRLDUG4;/.test(block),
    );
    expect(nameless).toHaveLength(0);
  });

  it('does not leave the team empty', () => {
    expect(source).not.toMatch(/DEVELOPMENT_TEAM = "";/);
    expect(source).not.toMatch(/DEVELOPMENT_TEAM = ;/);
  });

  it('uses the team that owns the certificate', () => {
    // J6NNRLDUG4 is the team that owns the Apple Development certificate
    // and both macOS provisioning profiles. A different team produces a signature that the
    // keychain rejects at the first write.
    expect(source).toMatch(/DEVELOPMENT_TEAM = J6NNRLDUG4;/);
  });
});
