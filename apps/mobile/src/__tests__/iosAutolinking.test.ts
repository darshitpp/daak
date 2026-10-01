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
      const spec = readFileSync(
        config.dependencies[`@daak/${name}`].platforms.ios.podspecPath,
        'utf8',
      );
      expect(spec).toContain(':ios');
      expect(spec).toContain('ios/**');
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
