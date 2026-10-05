import { readFileSync } from 'fs';
import { join } from 'path';

// The JS engine is invisible to every other suite. There is no JVM test source
// set in this module and no device on CI. If the VM library is absent from the
// APK, nothing fails at build time and nothing fails in JS: the process dies
// inside Activity.onCreate, before the first render, with
//
//   SoLoaderDSONotFoundError: couldn't find DSO to load: libhermesvm.so
//
// Measured on an arm64 emulator, API 36, from the release APK, 2026-10-06.
//
// Two facts cause it. react-android deliberately excludes libhermesvm.so from
// its own AAR, so the engine must come from a separate artifact. And
// react-native 0.83 moved that artifact from com.facebook.react:hermes-android
// to the com.facebook.hermes group, so the old coordinate resolves to nothing
// and the app still ships without a VM.
const repo = '../../../../';
const read = (p: string) => readFileSync(join(__dirname, repo, p), 'utf8');

const appGradle = 'apps/mobile/android/app/build.gradle';

// The engine declaration, if there is one. An empty `if (hermesEnabled)`
// branch is the state that shipped. Comments are stripped first: the shipped
// branch named hermes-android and spelled out the exact coordinate that 404s,
// so matching the bare artifact name proves nothing.
const hermesBranch = () => {
  const branch = /if \(hermesEnabled\.toBoolean\(\)\) \{([\s\S]*?)\n    \} else/.exec(read(appGradle))?.[1];
  return branch === undefined ? undefined : branch.replace(/\/\/[^\n]*/g, '');
};

describe('Android JS engine wiring', () => {
  // The engine has to be an explicit dependency. The empty branch compiled, the
  // bundle task still ran hermesc, and the APK carried libhermestooling.so
  // with no VM beside it.
  it('declares the Hermes VM artifact on the app classpath', () => {
    const hermes = hermesBranch();
    expect(hermes).toBeTruthy();
    expect(hermes).toMatch(/(implementation|api)[ (]/);
    expect(hermes).toMatch(/hermes-android/);
  });

  // The GROUP is the load-bearing half. com.facebook.react:hermes-android:0.83.10
  // is a 404. com.facebook.hermes:hermes-android:0.14.1 is the artifact that
  // exists. Matching the artifact name alone would let the old group back in.
  it('uses the com.facebook.hermes group, not com.facebook.react', () => {
    const hermes = hermesBranch() ?? '';
    expect(hermes).not.toMatch(/com\.facebook\.react:hermes-android/);
  });
});

