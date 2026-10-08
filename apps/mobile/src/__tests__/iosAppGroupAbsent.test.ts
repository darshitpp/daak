import { readFileSync } from 'fs';
import { join } from 'path';

// A free Apple team grants no App Group, so the .ipa must request none. The
// codesign half of iosSimulatorEntitlements.test.ts and
// iosAdhocSigningLaunch.test.ts only runs when a built product exists, so it
// SKIPS in CI. Nothing there stops a future edit from re-adding the key with a
// green CI run. This file reads the SOURCE directly and always runs.
const repo = '../../../../';
const read = (p: string) => readFileSync(join(__dirname, repo, p), 'utf8');

// The explanatory XML comment names the key and the group on purpose. Strip
// every XML comment first, or the comment alone would satisfy the pin.
const stripXmlComments = (xml: string) => xml.replace(/<!--[\s\S]*?-->/g, '');

const uncommented = (p: string) => stripXmlComments(read(p));

const app = 'apps/mobile/ios/Daak/Daak.entitlements';
const appex = 'apps/mobile/ios/DaakShareExtension/DaakShareExtension.entitlements';
const pbxproj = 'apps/mobile/ios/Daak.xcodeproj/project.pbxproj';

describe('the iOS app requests no App Group', () => {
  it.each([
    [app],
    [appex],
  ])('holds no application-groups key and no group string in %s', (path) => {
    const xml = uncommented(path);
    expect(xml).not.toMatch(/<key>com\.apple\.security\.application-groups<\/key>/);
    expect(xml).not.toContain('group.dev.darshit.daak');
  });

  // Only the BUILD PHASE is parsed. The appex still appears as a PBXFileReference
  // and in the target list, and both are allowed: the target stays, the
  // dependency stays, only the embed entry is gone.
  it('embeds no DaakShareExtension.appex in the Embed App Extensions phase', () => {
    const file = read(pbxproj);
    const start = file.indexOf('/* Embed App Extensions */ = {');
    expect(start).toBeGreaterThan(-1);
    const phase = file.slice(start, file.indexOf('};', start));
    expect(phase).not.toContain('DaakShareExtension.appex');
  });
});

