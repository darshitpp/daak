import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// The iOS Debug build for the SIMULATOR SDK is signed ADHOC. Xcode resolves
// that to "Sign to Run Locally", which carries NO team:
//
//   CodeSign .../Daak.app
//       Signing Identity:     "Sign to Run Locally"
//       /usr/bin/codesign --force --sign - --entitlements .../Daak.app.xcent
//
// Xcode nevertheless INJECTED the team-prefixed application-identifier into
// Daak.app.xcent, because the project declares no DEVELOPMENT_TEAM and Xcode
// resolved the prefix from the App Group provisioning profile:
//
//   <key>application-identifier</key>
//   <string>J6NNRLDUG4.dev.darshit.daak</string>
//
// An adhoc signature with a team-prefixed application-identifier is rejected
// by the simulator at exec time. The app never reaches its own code. Measured
// on a freshly created iPhone 17 simulator, built unmodified:
//
//   xpcproxy exited due to OS_REASON_EXEC
//   Bootstrapping failed ... RBSRequestErrorDomain; code: 5; "Launch failed."
//   NSPOSIXErrorDomain Code=163
//   Transaction failed. no client provider for identity app<dev.darshit.daak>
//
// The user-visible symptom is only:
//
//   Simulator device failed to launch dev.darshit.daak.
//   The request was denied by service delegate (SBMainWorkspace).
//
// Two teams' signatures were measured against the SAME product to separate
// the two entitlement keys:
//
//   adhoc + application-identifier + App Group   -> SIGKILLed at exec
//   adhoc + App Group only                       -> launches, App Group container
//                                                  resolves, UI renders
//   Apple Development, team J6NNRLDUG4           -> launches, UI renders
//                                                  (needs a certificate)
//
// So the team-prefixed application-identifier is the cause, and the App Group
// must STAY. Stripping the injected base entitlements is what
// CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO does, and it needs no certificate, so a
// clean checkout builds a launchable app.
//
// The setting is scoped to the SIMULATOR SDK on purpose. The unscoped form also
// stops injection for a DEVICE build. A device build takes its
// application-identifier from the provisioning profile, so removing it there
// breaks the App Group, the keychain, and every TestFlight build. The simulator
// is the only place the adhoc signature is a problem.
//
// @daak/mobile ships no iOS build in CI, so the codesign half SKIPS unless a
// built Debug-iphonesimulator product is pointed at. The source half below
// runs everywhere so CI still guards the setting that reverses the defect.
const derivedData = process.env.DAAK_IOS_DERIVED_DATA ?? '/tmp/daak-ios-dd';
const products = join(derivedData, 'Build', 'Products', 'Debug-iphonesimulator');
const app = join(products, 'Daak.app');

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

describeIfBuilt('iOS Debug simulator build survives exec', () => {
  // Asserted on the ABSENCE of the team prefix, because that is the exact key
  // the simulator rejects. Asserting only that the App Group is present passes
  // on the broken build: the broken product carries BOTH keys.
  it('does not sign a team-prefixed application-identifier into an adhoc build', () => {
    expect(signedEntitlements(app)).not.toMatch(/<key>application-identifier<\/key>/);
    expect(signedEntitlements(app)).not.toMatch(/J6NNRLDUG4\./);
  });

  // The App Group is still required. It is what the data-protection keychain
  // reads, and rn-securestore sets kSecUseDataProtectionKeychain = true:
  //
  //   keychain read failed for onboarding.v1: -34018 Nothing has been changed.
  //
  // So a fix that drops the App Group trades a launch failure for an
  // onboarding failure, which is why this assertion sits next to the one above.
  it('still signs the App Group the keychain needs', () => {
    expect(signedEntitlements(app)).toContain(
      '<key>com.apple.security.application-groups</key>',
    );
    expect(signedEntitlements(app)).toContain('<string>group.dev.darshit.daak</string>');
  });
});

describe('the build configuration stops Xcode injecting the team prefix', () => {
  const pbxproj = readFileSync(
    join(__dirname, '../../ios/Daak.xcodeproj/project.pbxproj'),
    'utf8',
  );

  // Every configuration that declares an entitlements path is returned
  // separately so Debug and Release are checked independently: a Debug-only
  // override is exactly how a TestFlight build ends up with no App Group and a
  // keychain that works only on the developer's own device.
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

  // The unscoped setting name, and the scoped name this file requires. Both
  // the guard below and its self-check compare against these two constants, so
  // the two sides cannot drift apart.
  const UNSCOPED = 'CODE_SIGN_INJECT_BASE_ENTITLEMENTS';
  const SCOPED = '"CODE_SIGN_INJECT_BASE_ENTITLEMENTS[sdk=iphonesimulator*]"';

  // Returns the NAME of every CODE_SIGN_INJECT_BASE_ENTITLEMENTS setting in the
  // block, quoted exactly as pbxproj writes it, with no value and no newline.
  //
  // The match must stop at the "=" on the SAME line. A character class such as
  // [^\"]* cannot do that: it runs to the next quote in the block, which is
  // usually on a later line, so the array holds the name plus trailing junk and
  // never holds the bare name. That is how a block carrying BOTH the scoped and
  // the unscoped line used to pass. The lookahead is what pins the match to one
  // line: [^\]\n]* refuses to cross a newline inside the scope suffix.
  // The condition part must allow MORE THAN ONE bracket group. A line can carry
  // two conditions and Xcode accepts it:
  //
  //   "CODE_SIGN_INJECT_BASE_ENTITLEMENTS[sdk=iphoneos*][sdk=iphonesimulator*]" = YES;
  //
  // A matcher written with ONE optional group (?:\[[^\]\n]*\])? returns an EMPTY
  // array for that line, so the guard reports nothing and the defect passes.
  // That shape also breaks a device build, so it must be reported. The star on
  // the group is what covers it.
  function settingsIn(block: string): string[] {
    return (
      block.match(/"?CODE_SIGN_INJECT_BASE_ENTITLEMENTS(?:\[[^\]\n]*\])*"?(?=[ \t]*=)/g) ?? []
    );
  }

  function setsUnscopedForm(lines: string[]): boolean {
    return settingsIn(lines.join('\n')).includes(UNSCOPED);
  }

  // A scope that is not the simulator is as harmful as no scope at all, so it
  // must be measured the same way. Measured on a copy of the real project file
  // that carried both lines:
  //
  //   xcodebuild -showBuildSettings -sdk iphonesimulator -> NO
  //   xcodebuild -showBuildSettings -sdk iphoneos        -> NO   <-- wrong
  //
  // The real project resolves iphoneos to YES, which is the Xcode default. So
  // an [arch=*] condition injects no base entitlements on a device build, which
  // drops the application-identifier, the App Group, and the keychain.
  const OTHER_SCOPE = '"CODE_SIGN_INJECT_BASE_ENTITLEMENTS[arch=*]"';
  const OTHER_SCOPE_LINE = `${OTHER_SCOPE} = NO;`;

  function settingsOutsideSimulatorScope(lines: string[]): string[] {
    return settingsIn(lines.join('\n')).filter((name) => name !== SCOPED);
  }

  // EVERY buildSettings block in the file, with no filter on which target or
  // which level declares it. The blocks that declare CODE_SIGN_ENTITLEMENTS are
  // only 4 of the 8. A condition added to a PBXProject level block or to the
  // Daak target changes the resolved value for the app, and the
  // per-entitlements-path guard above never reads it. Measured on three copies,
  // one line of [arch=*] each, with -sdk iphoneos:
  //
  //   PBXProject level Debug   -> NO   <-- wrong, this one overrides
  //   DaakTests target Debug   -> YES  <-- harmless, it is not this target
  //   Daak target Debug        -> NO   <-- wrong
  //
  // The real project reads YES on the device SDK. So the guard covers all 8
  // blocks, and the count is pinned so a restructure cannot silently shrink it.
  function allSettingsBlocks(): string[] {
    const out: string[] = [];
    let at = pbxproj.indexOf('buildSettings = {');
    while (at !== -1) {
      const start = pbxproj.indexOf('{', at);
      out.push(pbxproj.slice(start, pbxproj.indexOf('};', start)));
      at = pbxproj.indexOf('buildSettings = {', at + 1);
    }
    return out;
  }

  it.each([
    ['Daak/Daak.entitlements'],
    ['DaakShareExtension/DaakShareExtension.entitlements'],
  ])('stops injecting the team prefix into %s in every configuration', (entitlementsPath) => {
    const blocks = configBlocksDeclaring(entitlementsPath);
    // Two configurations per target. Asserted so that deleting a whole
    // configuration cannot leave the loop below vacuously green.
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block).toMatch(/"?CODE_SIGN_INJECT_BASE_ENTITLEMENTS\[sdk=iphonesimulator\*\]"? = NO;/);
    }
  });

  // The unscoped setting is a regression, not a fallback. It reads as a stricter
  // version of the same line and hides inside the scoped line, because the
  // scoped name is the unscoped name plus "[sdk=iphonesimulator*]". A plain
  // contains check therefore passes on the scoped line and proves nothing, so
  // this compares the setting NAME instead: settingsIn returns the name alone,
  // so the unscoped form appears in the array as the bare name.
  it.each([
    ['Daak/Daak.entitlements'],
    ['DaakShareExtension/DaakShareExtension.entitlements'],
  ])('does not set the unscoped form on %s', (entitlementsPath) => {
    const blocks = configBlocksDeclaring(entitlementsPath);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      const names = settingsIn(block);
      expect(names).not.toContain(UNSCOPED);
      expect(names).toEqual(expect.arrayContaining([SCOPED]));
    }
  });

  // The unscoped form is one way to reach a device build. Any condition that
  // is not [sdk=iphonesimulator*] is another, so the guard rejects every other
  // form instead of only the bare name.
  it.each([
    ['Daak/Daak.entitlements'],
    ['DaakShareExtension/DaakShareExtension.entitlements'],
  ])('does not set any other condition form on %s', (entitlementsPath) => {
    const blocks = configBlocksDeclaring(entitlementsPath);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(settingsOutsideSimulatorScope([block])).toEqual([]);
    }
  });

  // The per-entitlements-path guard above covers 4 of the 8 buildSettings
  // blocks. This one covers all of them, so a condition cannot be placed where
  // the entitlements path is absent. The count is asserted because a guard
  // that reads zero blocks passes vacuously.
  it('does not set any other condition form in any build settings block', () => {
    const blocks = allSettingsBlocks();
    expect(blocks).toHaveLength(8);
    const offenders = blocks.flatMap((block) => settingsOutsideSimulatorScope([block]));
    expect(offenders).toEqual([]);
  });

  // The selector is the part that must not silently shrink, so it is pinned
  // against a block that carries no CODE_SIGN_ENTITLEMENTS line at all. That is
  // the shape of the PBXProject level block and of the DaakTests target block.
  it('reads a build settings block that declares no entitlements path', () => {
    const block = [
      'CODE_SIGN_IDENTITY = "Apple Development";',
      OTHER_SCOPE_LINE,
      'SWIFT_VERSION = 5.0;',
    ].join('\n');
    expect(block).not.toContain('CODE_SIGN_ENTITLEMENTS');
    expect(settingsOutsideSimulatorScope([block])).toEqual([OTHER_SCOPE]);
  });

  // The matcher is the part that broke silently, so it is pinned here against
  // the four shapes a block can take. The third case is the defect: before the
  // fix, a block with BOTH lines passed both assertions above, because the
  // match ran past the newline and never produced the bare name.
  const SCOPED_LINE = `${SCOPED} = NO;`;
  const UNSCOPED_LINE = `${UNSCOPED} = NO;`;

  it.each([
    ['the scoped line alone', [SCOPED_LINE], false],
    ['the unscoped line alone', [UNSCOPED_LINE], true],
    ['the unscoped line after the scoped line', [SCOPED_LINE, UNSCOPED_LINE], true],
    ['the unscoped line before the scoped line', [UNSCOPED_LINE, SCOPED_LINE], true],
  ])('reports the unscoped form for %s', (_shape, lines, expected) => {
    expect(setsUnscopedForm(lines)).toBe(expected);
  });

  it.each([
    ['the scoped line alone', [SCOPED_LINE], []],
    ['an other-scope line alone', [OTHER_SCOPE_LINE], [OTHER_SCOPE]],
    ['an other-scope line after the scoped line', [SCOPED_LINE, OTHER_SCOPE_LINE], [OTHER_SCOPE]],
    ['an other-scope line before the scoped line', [OTHER_SCOPE_LINE, SCOPED_LINE], [OTHER_SCOPE]],
  ])('reports a non-simulator condition for %s', (_shape, lines, expected) => {
    expect(settingsOutsideSimulatorScope(lines)).toEqual(expected);
  });

  // TWO CONDITIONS ON ONE LINE. This is the shape the old matcher missed: it
  // allowed one optional bracket group, so a second group made the whole match
  // fail and the guard saw nothing. Xcode accepts two conditions on one setting,
  // and a form that mentions a device SDK injects no base entitlements on a
  // device build, which drops the App Group and the keychain.
  it.each([
    [
      'two conditions naming the device SDK',
      '"CODE_SIGN_INJECT_BASE_ENTITLEMENTS[sdk=iphonesimulator*][sdk=iphoneos*]" = YES;',
    ],
    [
      'two conditions naming the architecture first',
      '"CODE_SIGN_INJECT_BASE_ENTITLEMENTS[arch=arm64][sdk=iphonesimulator*]" = NO;',
    ],
    ['three conditions', '"CODE_SIGN_INJECT_BASE_ENTITLEMENTS[a=1][b=2][c=3]" = NO;'],
  ])('reports %s', (_shape, line) => {
    expect(settingsOutsideSimulatorScope([line])).toEqual([line.split(' = ')[0]]);
  });

  // The same two-condition shape must not be mistaken for the simulator scope.
  // The guard compares the WHOLE name, so a longer name can never equal the
  // quoted simulator name and is always reported.
  it('does not mistake a two-condition name for the simulator scope', () => {
    const line = '"CODE_SIGN_INJECT_BASE_ENTITLEMENTS[sdk=iphonesimulator*][arch=*]" = NO;';
    expect(settingsIn(line)).toHaveLength(1);
    expect(settingsOutsideSimulatorScope([line])).toHaveLength(1);
  });
});
