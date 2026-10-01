import { existsSync, readFileSync, realpathSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';

// On 2026-10-01 the app was installed on a booted simulator and launched. The JS
// bundle loaded, the UI rendered, and then:
//
//   Invariant Violation: TurboModuleRegistry.getEnforcing(...): 'DaakBgSched'
//   could not be found. Verify that a module by this name is registered in the
//   native binary.
//
// pod install had run and reported success, and Podfile.lock contained no Daak*
// pod at all -- not DaakBgSched, not DaakShare, not DaakNotify. ZERO of the seven
// iOS TurboModules were linked, so every one of them fails that way. No JS test
// can see this: it is decided by CocoaPods, before any JS runs, and a pod that is
// missing produces no JS-visible error until getEnforcing.
//
// THE CAUSE is a structural mismatch between where the podspecs live and where the
// RN CLI looks for them. findPodspec (cli-config-apple) does a NON-recursive
// fast-glob for '*.podspec' at the PACKAGE ROOT. Five modules keep their podspec
// in ios/ with no root podspec, so they are invisible to autolinking, always. The
// other two (rn-notify, rn-share) DO have a root podspec -- one declaring only
// :osx, for macOS -- so the CLI resolves those and iOS then skips them
// (native_modules.rb: `next unless spec.supported_on_platform?`).
//
// The fix is the CLI's own sanctioned override, in react-native.config.js, which
// already exists here with an empty `dependencies: {}` waiting for it. Moving or
// renaming podspecs instead would churn the macOS side that works today.
const appDir = join(__dirname, '..', '..');

// Every module the app imports through packages/platform. All seven must be
// autolinked for iOS or a getEnforcing on any of them is a launch-time crash.
const MODULES = [
  'rn-bgsched',
  'rn-clipboard',
  'rn-fspaths',
  'rn-notify',
  'rn-qrscanner',
  'rn-securestore',
  'rn-share',
];

describe('every iOS TurboModule is autolinked', () => {
  const config = require(join(appDir, 'react-native.config.js'));

  for (const name of MODULES) {
    it(`points ${name} at a podspec that exists`, () => {
      const dep = config.dependencies?.[`@daak/${name}`];
      expect(dep).toBeDefined();
      const podspec = dep.platforms?.ios?.podspecPath;
      expect(typeof podspec).toBe('string');
      // A path that does not exist is worse than no override at all: the CLI
      // reports it, pod install warns, and the pod is still not linked.
      expect(existsSync(podspec)).toBe(true);
    });

    it(`points ${name} at its IOS spec, not the macOS one`, () => {
      // A podspecPath that exists but is the :osx spec links a pod whose
      // source_files is macos/**, which cannot compile for iOS. That surfaces as
      // a confusing missing-symbol build error rather than the real cause.
      //
      // Deliberately does NOT assert the spec's TEXT contains ':ios' or
      // 'ios/**'. Those literals are satisfied by the podspec's own explanatory
      // comments -- every one of the seven comments names modules/rn-<mod>/ios/
      // ios/**, the very path that broke the build. A check that passes on a
      // comment is worse than no check: it is green, and it fails when someone
      // deletes a comment. iosPodSourceFiles.test.ts asserts the real invariant
      // by matching source_files against real filenames, and the CLI-resolution
 // test below proves the override reaches CocoaPods.
      const spec = readFileSync(
        config.dependencies[`@daak/${name}`].platforms.ios.podspecPath,
        'utf8',
      );
      // What must hold: the file the override names is under ios/, and declares
      // the iOS platform, read from the executable part of the spec.
      expect(config.dependencies[`@daak/${name}`].platforms.ios.podspecPath).toMatch(
        /modules\/rn-[a-z]+\/ios\/Daak\w+\.podspec$/,
      );
      // Read the platforms line as code: an uncommented `s.platforms = {...}`
      // carrying :ios. Stripping comments first means the check cannot be
      // satisfied by prose about :ios, and cannot break when prose is edited.
      const code = spec
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n');
      expect(code).toMatch(/s\.platforms\s*=\s*\{\s*:ios\s*=>/);
    });
  }

  it('the CLI resolves each module to that same podspec', () => {
    // The override and the CLI must agree. Asserting on the config file alone
    // would pass even if the CLI ignored the key -- which is precisely the bug
    // that shipped: a correct-looking config that never reached CocoaPods.
    const cli = require.resolve('@react-native-community/cli/build/bin.js', {
      paths: [appDir],
    });
    const out = execFileSync('node', [cli, 'config', '--platform', 'ios'], {
      cwd: appDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const resolved = JSON.parse(out).dependencies;
    for (const name of MODULES) {
      const declared = config.dependencies[`@daak/${name}`].platforms.ios
        .podspecPath;
      expect(resolved[`@daak/${name}`]?.platforms?.ios?.podspecPath).toBe(
        realpathSync(declared),
      );
    }
  });
});
