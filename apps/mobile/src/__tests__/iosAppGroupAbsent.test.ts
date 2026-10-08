import { readFileSync } from 'fs';
import { join } from 'path';

// A free Apple team grants no App Group, so a sideload .ipa must request none.
// The codesign half of iosSimulatorEntitlements.test.ts and
// iosAdhocSigningLaunch.test.ts only runs when a built product exists, so it
// SKIPS in CI. Nothing there stops a future edit from re-adding the key to the
// SHIPPED files with a green CI run. This file reads the SOURCE directly and
// always runs.
//
// The iOS 26 simulator keychain is the other half. Measured on the iPhone 17
// simulator with an adhoc "Sign to Run Locally" signature:
//   - an empty entitlements file launches, and SecItemCopyMatching returns
//     -34018 (errSecMissingEntitlement);
//   - keychain-access-groups SIGKILLs the app at exec, launch denied by
//     SBMainWorkspace, with or without a team prefix;
//   - only com.apple.security.application-groups makes the read succeed.
// So the App Group is the SIMULATOR keychain grant. It lives in
// Daak.simulator.entitlements, selected with
// CODE_SIGN_ENTITLEMENTS[sdk=iphonesimulator*], and NOT in the shipped files.
const repo = '../../../../';
const read = (p: string) => readFileSync(join(__dirname, repo, p), 'utf8');

// The explanatory XML comment names the key and the group on purpose. Strip
// every XML comment first, or the comment alone would satisfy the pin.
const stripXmlComments = (xml: string) => xml.replace(/<!--[\s\S]*?-->/g, '');
const uncommented = (p: string) => stripXmlComments(read(p));

const app = 'apps/mobile/ios/Daak/Daak.entitlements';
const appex = 'apps/mobile/ios/DaakShareExtension/DaakShareExtension.entitlements';
const sim = 'apps/mobile/ios/Daak/Daak.simulator.entitlements';
const pbxproj = 'apps/mobile/ios/Daak.xcodeproj/project.pbxproj';

describe('the shipped iOS entitlements request no App Group', () => {
  // keychain-access-groups is deliberately NOT forbidden here. The keychain
  // needs an access-group entitlement, and the pin must not be the reason the
  // next person cannot try one. It is also not used: measured, it SIGKILLs an
  // adhoc-signed simulator app at exec, so it cannot be the simulator grant.
  it.each([
    [app],
    [appex],
  ])('holds no application-groups key and no group string in %s', (path) => {
    const xml = uncommented(path);
    expect(xml).not.toMatch(/<key>com\.apple\.security\.application-groups<\/key>/);
    expect(xml).not.toContain('group.dev.darshit.daak');
  });
});

describe('the SIMULATOR build carries the App Group the keychain needs', () => {
  it('selects the simulator entitlements file for the iphonesimulator SDK', () => {
    expect(read(pbxproj)).toMatch(
      /"CODE_SIGN_ENTITLEMENTS\[sdk=iphonesimulator\*\]" = Daak\/Daak\.simulator\.entitlements;/,
    );
  });

  // This is the check that fails if the keychain-access entitlement is removed:
  // delete the App Group from the simulator file and the -34018 banner returns.
  it('grants the App Group in Daak.simulator.entitlements', () => {
    const xml = uncommented(sim);
    expect(xml).toMatch(/<key>com\.apple\.security\.application-groups<\/key>/);
    expect(xml).toContain('group.dev.darshit.daak');
  });
});

// Only the BUILD PHASE is parsed. The appex still appears as a PBXFileReference
// and in the target list, and both are allowed: the target stays, the
// dependency stays, only the embed entry is gone.
describe('the ShareExtension is not embedded', () => {
  it('embeds no DaakShareExtension.appex in the Embed App Extensions phase', () => {
    const file = read(pbxproj);
    const start = file.indexOf('/* Embed App Extensions */ = {');
    expect(start).toBeGreaterThan(-1);
    const phase = file.slice(start, file.indexOf('};', start));
    expect(phase).not.toContain('DaakShareExtension.appex');
  });
});
