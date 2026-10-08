import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

// The iOS release ships an UNSIGNED .ipa. There is no paid Apple Developer
// Program, so there is no iOS Distribution certificate. The user sideloads the
// .ipa with AltStore or SideStore, which re-signs it with a free Apple ID.
//
// The packaging script is the release step. A hand build drifts: a different
// derived-data path, signing left ON, or a leftover share extension all
// produce an .ipa that the free profile refuses to install. So this file pins
// the shape of the script.
//
// Every assertion strips comment lines first. The script carries long
// why-comments that name the very strings under test, so a raw match would
// pass on a comment alone.
const repo = '../../../../';
const script = 'apps/mobile/scripts/package-ipa.sh';
const scriptPath = join(__dirname, repo, script);
const stripComments = (s: string): string =>
  s
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

// The DEVICE entitlements file must request no App Group. A free team grants
// no App Group, so an .ipa that requests the key fails to install. The file's
// XML comment names the key on purpose. Strip every XML comment first, or the
// comment alone satisfies the pin.
const stripXmlComments = (xml: string): string => xml.replace(/<!--[\s\S]*?-->/g, '');

describe('the iOS unsigned .ipa packaging script', () => {
  const exists = existsSync(scriptPath);
  const source = exists ? readFileSync(scriptPath, 'utf8') : '';
  const code = stripComments(source);

  it('exists with the owner-execute bit set', () => {
    expect(exists).toBe(true);
    const mode = exists ? statSync(scriptPath).mode : 0;
    expect(mode & 0o100).toBe(0o100);
  });

  it('archives with xcodebuild, the Daak scheme, and the archive action', () => {
    expect(code).toMatch(/xcodebuild/);
    expect(code).toMatch(/-scheme\s+Daak\b/);
    expect(code).toMatch(/\barchive\b/);
  });

  it('disables code signing for the archive', () => {
    // No iOS Distribution certificate exists. The .ipa is unsigned.
    expect(code).toMatch(/CODE_SIGNING_ALLOWED=NO/);
    expect(code).toMatch(/CODE_SIGNING_REQUIRED=NO/);
  });

  it('archives for the generic iOS device destination', () => {
    expect(code).toMatch(/generic\/platform=iOS/);
  });

  it('uses the fixed scratch derived-data path', () => {
    // The host disk is nearly full. One path for this target reuses the cache.
    expect(code).toMatch(/SCRATCH="\$\{TMPDIR%\/\}\/daak"/);
    expect(code).toMatch(/DERIVED="\$SCRATCH\/dd_ios"/);
    expect(code).toMatch(/-derivedDataPath/);
  });

  it('zips a Payload directory into the .ipa', () => {
    expect(code).toMatch(/Payload/);
    expect(code).toMatch(/\bzip\b/);
  });

  it('asserts the app holds no PlugIns directory', () => {
    expect(code).toMatch(/test ! -d "\$APP\/PlugIns"/);
  });

  it('reads the version from release/version.json', () => {
    expect(code).toMatch(/release\/version\.json/);
  });

  it('checks the version stamp before the build', () => {
    expect(code).toMatch(/stamp-version\.mjs --check/);
  });

  it('does not sign or notarize, and ships no store lane', () => {
    // The script must not sign the app and must not notarize it. A call to a
    // signing or notarization tool fails, because no credential exists.
    for (const forbidden of [
      'notarytool',
      'altool',
      'fastlane',
      'app-store-connect',
    ]) {
      expect(code).not.toMatch(new RegExp(forbidden));
    }
  });
});

describe('the DEVICE entitlements request no App Group', () => {
  it('holds no application-groups key', () => {
    const xml = stripXmlComments(
      readFileSync(join(__dirname, repo, 'apps/mobile/ios/Daak/Daak.entitlements'), 'utf8'),
    );
    expect(xml).not.toMatch(/<key>com\.apple\.security\.application-groups<\/key>/);
  });
});
