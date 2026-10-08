import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

// The Android release signing helper reads the upload-key password from the
// macOS login Keychain and hands it to Gradle through the environment. No
// runtime test can exercise it: that needs a Keychain item, an Android SDK,
// and a full release build. So this file pins the shape of the script, because
// every failure mode here is SILENT or DANGEROUS.
//
//   * a missing or non-executable script is obvious, but a script that reads
//     the wrong Keychain service fails only at release time with a confusing
//     Gradle error;
//   * `set -x` prints every expanded value, so the password export lines
//     would write the password to the terminal and to every log the caller
//     redirects to;
//   * an echo of a password variable does the same in one line.
//
// Every assertion strips comment lines first, as the other source pins in this
// directory do. The script carries long why-comments that name the very
// strings under test, so a raw match would pass on a comment alone.
const repo = '../../../../';
const script = 'scripts/sign-android.sh';
const scriptPath = join(__dirname, repo, script);
const stripComments = (s: string): string =>
  s
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

describe('Android signing helper script', () => {
  it('exists with the owner-execute bit set', () => {
    expect(existsSync(scriptPath)).toBe(true);
    expect(statSync(scriptPath).mode & 0o100).toBe(0o100);
  });

  it('names the Keychain service in the password lookup', () => {
    const code = stripComments(readFileSync(scriptPath, 'utf8'));
    expect(code).toMatch(/security find-generic-password/);
    expect(code).toMatch(/-a daak/);
    // The service name is the whole point: a wrong or missing -s reads a
    // different item, or prompts, and the build fails far from the cause.
    expect(code).toMatch(/-s daak-android-upload/);
    expect(code).toMatch(/-w/);
  });

  it('never enables shell tracing', () => {
    const code = stripComments(readFileSync(scriptPath, 'utf8'));
    expect(code).not.toMatch(/set -[a-z]*x/);
  });

  it('never echoes or prints a password variable', () => {
    const code = stripComments(readFileSync(scriptPath, 'utf8'));
    const leaks = code
      .split('\n')
      .filter((l) => /(?:echo|printf)/.test(l) && /ANDROID_KEY(STORE)?_PASSWORD/.test(l));
    expect(leaks).toEqual([]);
  });

  it('exports all four ANDROID_KEY* variables', () => {
    const code = stripComments(readFileSync(scriptPath, 'utf8'));
    const exports = code
      .split('\n')
      .filter((l) => /^\s*export\b/.test(l))
      .join('\n');
    for (const name of [
      'ANDROID_KEYSTORE_PATH',
      'ANDROID_KEYSTORE_PASSWORD',
      'ANDROID_KEY_ALIAS',
      'ANDROID_KEY_PASSWORD',
    ]) {
      expect(exports).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it('runs the release Gradle task offline', () => {
    const code = stripComments(readFileSync(scriptPath, 'utf8'));
    expect(code).toMatch(/\.\/gradlew\s+:app:assembleRelease/);
    expect(code).toMatch(/--offline/);
  });
});
