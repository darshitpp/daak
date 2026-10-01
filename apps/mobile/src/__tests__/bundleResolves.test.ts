import { existsSync } from 'fs';
import { join } from 'path';

// The JS bundle failing to BUILD is the one React Native failure mode that
// no native test suite can see, because it happens before any native code
// runs: Metro resolves the whole module graph, and a single unresolvable spec
// produces a red box on launch on EVERY platform, not just iOS.
//
// This is not hypothetical. On 2026-10-01 the app was installed on a booted
// simulator, launched, and sat at a solid React Native red box. The cause was
// that index.js emits `require("@babel/runtime/helpers/interopRequireDefault")`
// -- transform-runtime output -- while @babel/runtime was only ever a
// TRANSITIVE dependency, reachable solely through metro-runtime's own
// node_modules. pnpm does not hoist, so nothing at the app's own resolution
// scope could see it.
//
// npm and yarn hoist transitive dependencies and would have papered over this
// entirely, which is exactly why it survived until the first real launch.
// Hence a source-level pin rather than "it built, so it works".
//
// Asserted two ways, because either alone has a failure mode:
//   1. the package is DECLARED, so pnpm links it into the app's own
//      node_modules where Metro can see it;
//   2. it is actually LINKED there right now, which catches a declared-but-
//      not-installed state (a stale lockfile) that (1) passes.
//
// (2) deliberately asserts on the PATH and not on `require.resolve`. Jest's
// resolver walks a different, more forgiving graph than Metro's -- with the
// dependency undeclared, `require.resolve` from this test still succeeded
// through Jest's own resolution while Metro failed in the real app. Asserting
// the path is what actually distinguishes the two resolvers.
const appDir = join(__dirname, '..', '..');

describe("Metro's resolver is compatible with pnpm's isolated node_modules", () => {
  it('does not disable hierarchical lookup', () => {
    // This is the ROOT CAUSE, and it is a config bug, not a missing package.
    //
    // pnpm stores a package's dependencies as SIBLINGS of the package itself:
    //   node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>
    //   node_modules/.pnpm/<pkg>@<ver>/node_modules/<dep>   <-- the dep, here
    // There is no <pkg>/node_modules/<dep>. So react-native/index.js doing
    // require('invariant') can ONLY be resolved by walking UP the directory
    // tree out of <pkg> and into that sibling directory. disableHierarchicalLookup
    // forbids exactly that walk, and additionally pins the resolver to the two
    // static nodeModulesPaths -- neither of which contains `invariant`.
    //
    // The consequence is that react-native's own index.js cannot be bundled at
    // all, on ANY platform: Metro 500s before a single line of app code runs, so
    // the app launches straight into a React Native red box. Adding packages to
    // apps/mobile/package.json to appease it would be treating the symptom and
    // would leave every OTHER transitively-required module one failure away.
    // The one-line config fix is the whole fix for that class.
    //
    // @babel/runtime is the one exception and is pinned above: transform-runtime
    // emits requires into the APP's own sources, so it must be declared by the
    // app regardless of how the resolver walks.
    const config = require(join(appDir, 'metro.config.js'));
    expect(config.resolver.disableHierarchicalLookup).toBeFalsy();
  });
});

describe('the JS bundle can be built', () => {
  it('declares @babel/runtime, which transform-runtime output requires at runtime', () => {
    const pkg = require(join(appDir, 'package.json'));
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(declared['@babel/runtime']).toBeDefined();
  });

  it('links @babel/runtime into the app node_modules, where Metro looks', () => {
    // pnpm symlinks every DECLARED dependency into the depending package's own
    // node_modules, and only those. Its absence here is precisely why Metro
    // could not resolve the import.
    expect(existsSync(join(appDir, 'node_modules', '@babel', 'runtime'))).toBe(true);
    expect(
      existsSync(
        join(
          appDir,
          'node_modules',
          '@babel',
          'runtime',
          'helpers',
          'interopRequireDefault.js',
        ),
      ),
    ).toBe(true);
  });
});
