import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// The iOS Debug build for the SIMULATOR SDK must send its entitlements to the
// code signature, not into a Mach-O section. The original defect hid the App
// Group there, and the data-protection keychain then refused the read:
//
//   Daak could not read this device
//   keychain read failed for onboarding.v1: _34018
//
// _34018 is errSecMissingEntitlement. rn-securestore sets
// kSecUseDataProtectionKeychain = true, and the data-protection keychain on the
// simulator grants access only to a process whose SIGNATURE carries the App
// Group. Daak.entitlements declares it and CODE_SIGN_ENTITLEMENTS points at
// that file, and the app still failed, because Xcode built and signed with a
// DIFFERENT entitlements file.
//
// For the iphonesimulator SDK Xcode produces two entitlements files and only
// one of them carries the App Group:
//
//   ProcessProductPackaging ... Daak.app-Simulated.xcent
//     com.apple.security.application-groups = group.dev.darshit.daak
//   ProcessProductPackaging ... Daak.app.xcent
//     (nothing)
//
// -showBuildSettings names the cause outright: for the simulator SDK Xcode
// resolves ENTITLEMENTS_DESTINATION to __entitlements, and for the device SDK to
// Signature. That is the whole bug. The MacOSX/embedded-simulator spec feeds
// ENTITLEMENTS_DESTINATION straight to the linker as
// -sectcreate __TEXT __entitlements, so the packaged entitlements land in a
// Mach-O SECTION instead of the code signature -- and codesign is then handed a
// second, empty xcent to sign with:
//
//   ProcessProductPackaging .../Daak.entitlements .../Daak.app.xcent
//       Entitlements:
//       {
//   }
//   CodeSign .../Daak.app
//       /usr/bin/codesign --force --sign - --entitlements .../Daak.app.xcent
//
// Both facts are visible in one RED build: the app's __TEXT,__entitlements
// section does contain group.dev.darshit.daak (it came from the sibling
// -Simulated.xcent), while `codesign -d --entitlements -` on the same binary
// returns <dict></dict>. Only the signature is what the keychain reads.
//
// The check below runs the real codesign -d --entitlements - against the real
// built product, because that is the only thing the OS acts on. Asserting on
// project.pbxproj alone would be the iosPodSourceFiles.test.ts mistake again: a
// build setting that reads correctly and does nothing still passes a
// string-matching pin.
//
// @daak/mobile ships no iOS build in CI, so the codesign half SKIPS unless a
// built Debug-iphonesimulator product is pointed at. The source half below runs
// everywhere so CI still guards the setting that reverses the defect.
const derivedData = process.env.DAAK_IOS_DERIVED_DATA ?? '/tmp/daak-ios-dd';
const products = join(derivedData, 'Build', 'Products', 'Debug-iphonesimulator');
const app = join(products, 'Daak.app');
const appex = join(app, 'PlugIns', 'DaakShareExtension.appex');

const describeIfBuilt = existsSync(app) ? describe : describe.skip;

// codesign writes "Executable=..." ahead of the plist on stderr, so the parse
// starts at the XML declaration to keep it deterministic across Xcode versions.
function signedEntitlements(bundle: string): string {
  const raw = execFileSync('codesign', ['-d', '--entitlements', '-', '--xml', bundle], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const start = raw.indexOf('<?xml');
  return start === -1 ? '' : raw.slice(start);
}

describeIfBuilt('iOS Debug simulator build carries no App Group', () => {
  // A free Apple team grants no App Group, so a sideload profile lacks the
  // key and the install fails at signing time. The key is removed from the app.
  it('signs Daak.app without an application-groups key', () => {
    expect(signedEntitlements(app)).not.toContain(
      '<key>com.apple.security.application-groups</key>',
    );
    expect(signedEntitlements(app)).not.toContain('group.dev.darshit.daak');
  });

  // The .ipa must carry no .appex. A free team cannot sign the extension, so
  // the extension is not embedded in the app.
  it('does not embed the ShareExtension', () => {
    expect(existsSync(appex)).toBe(false);
  });
});

describe('the build configuration asks Xcode to keep the entitlements', () => {
  // A source pin, in the accepted iosPodSourceFiles.test.ts style: the defect
  // lived in a build setting for a whole release, so the setting that reverses
  // it is pinned even where no iOS product exists to codesign.
  const pbxproj = readFileSync(
    join(__dirname, '../../ios/Daak.xcodeproj/project.pbxproj'),
    'utf8',
  );

  // Every configuration that declares this entitlements path has to send the
  // entitlements to the signature, and each configuration is returned
  // separately so Debug and Release are checked independently: a Debug-only
  // override is exactly how a TestFlight build ends up with no App Group and a
  // keychain that works only on the developer's own device. The device SDK
  // already resolves to Signature on its own, so the simulator-scoped override
  // is the only thing that actually changes here.
  function configBlocksDeclaring(entitlementsPath: string): string[] {
    const out: string[] = [];
    let at = pbxproj.indexOf('CODE_SIGN_ENTITLEMENTS = ');
    while (at !== -1) {
      const line = pbxproj.slice(at, pbxproj.indexOf('\n', at));
      if (line.includes(entitlementsPath)) {
        // The block ends at the closing brace of its buildSettings dict.
        out.push(pbxproj.slice(at, pbxproj.indexOf('};', at)));
      }
      at = pbxproj.indexOf('CODE_SIGN_ENTITLEMENTS = ', at + 1);
    }
    return out;
  }

  it.each([
    ['Daak/Daak.entitlements'],
    ['DaakShareExtension/DaakShareExtension.entitlements'],
  ])('sends %s to the signature in every configuration', (entitlementsPath) => {
    const blocks = configBlocksDeclaring(entitlementsPath);
    // Two configurations per target. Asserted so that deleting a whole
    // configuration cannot leave the loop below vacuously green.
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block).toMatch(/"?ENTITLEMENTS_DESTINATION\[sdk=iphonesimulator\*\]"? = Signature;/);
    }
  });

  // The things that are known NOT to work, pinned so they are not reached for
  // again: none of them stops Xcode writing an empty Daak.app.xcent, and all of
  // them were tried against a real Debug-iphonesimulator build first. A team id
  // is additionally forbidden by AGENTS.md.
  it('does not reach for a team id or a signing-style override', () => {
    expect(pbxproj).not.toMatch(/DEVELOPMENT_TEAM/);
    expect(pbxproj).not.toMatch(/CODE_SIGN_ALLOW_ENTITLEMENTS_MODIFICATION/);
    // ENTITLEMENTS_ALLOWED reads like the fix and is not: it resolves to YES on
    // the simulator and the signed entitlements stay empty. Pinned so the next
    // person does not spend a build on it again.
    expect(pbxproj).not.toMatch(/ENTITLEMENTS_ALLOWED/);
  });
});
