import { readFileSync } from 'fs';
import { join } from 'path';

// The "codegen" script decides WHERE react-native codegen writes the Android
// and iOS spec files. Run from the app root, the 0.76 generator writes every
// library's Android spec into the app's own
// android/app/build/generated/source/codegen/jni directory. RN's generated
// CMakeLists globs that directory with CONFIGURE_DEPENDS, and autolinking adds
// each module's own copy too, so every spec compiles twice into
// libappmodules.so and the release link fails with duplicate symbols.
//
// Two rules stop that: change directory into the platform folder first, and
// keep the codegen package on the same major.minor as react-native. Comments
// are stripped first, because a raw match would pass on a comment alone.
//
// The plain `cd ios && react-native codegen` form FAILS: the CLI reads its
// project root from the current directory, and `ios/` holds no package.json.
// The script must pass `--path ..` to reach the app package.json.

const pkgPath = join(__dirname, '../../package.json');

const stripComments = (s: string): string =>
  s
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join('\n');

const readPackage = (): any => JSON.parse(readFileSync(pkgPath, 'utf8'));

const codegenScript = (pkg: any): string =>
  stripComments(String(pkg.scripts?.codegen ?? ''));

const minor = (v: string): string => String(v).replace(/^[^0-9]*/, '').split('.').slice(0, 2).join('.');

describe('mobile codegen script', () => {
  it('changes directory into a platform folder before it runs codegen', () => {
    const script = codegenScript(readPackage());
    expect(script).toMatch(/^\s*cd\s+(ios|android|macos|windows)\b/);
  });

  it('keeps every @react-native/* devDependency on the same major.minor as react-native', () => {
    const pkg = readPackage();
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const rn = minor(deps['react-native']);
    for (const name of ['@react-native/codegen', '@react-native/gradle-plugin']) {
      if (deps[name] === undefined) {
        continue;
      }
      // The pair form names the failing package in the report.
      expect([name, minor(deps[name])]).toEqual([name, rn]);
    }
  });
});
