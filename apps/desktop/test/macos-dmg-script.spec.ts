import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './strip-comments';

// strip-comments removes `//` and `/* */`. A shell script comments with `#`,
// so the shared helper leaves each `#` line in place. Drop the shell comments
// first, then hand the rest to the shared helper. Without this step the
// negative assertions below match the script's own prose and prove nothing.
function stripShellComments(source: string): string {
  return source
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n');
}

// The macOS release .dmg is built by one script, not by hand. A hand build
// drifts: a different derived-data path, a missing authority check, or a
// forgotten `hdiutil verify` all produce a .dmg that looks fine and fails at
// the user. So the script is the release step, and these tests pin its shape.
//
// The script carries long why-comments that name the very strings under test
// (notarytool, stapler, `--options runtime`). A raw count over the unstripped
// file would match its own prose. So every code assertion reads the source with
// comments removed.
const script = join(__dirname, '..', 'macos', 'scripts', 'package-dmg.sh');

describe('the macOS .dmg packaging script', () => {
  const exists = existsSync(script);
  const source = exists ? readFileSync(script, 'utf8') : '';
  const code = stripComments(stripShellComments(source));

  it('exists as an executable file', () => {
    expect(exists).toBe(true);
    // The owner-execute bit. A non-executable packaging script is a script that
    // the release runner calls and the shell refuses to start.
    const mode = exists ? statSync(script).mode : 0;
    expect(mode & 0o100).not.toBe(0);
  });

  it('archives with xcodebuild, the Daak-macOS scheme, and the archive action', () => {
    expect(code).toMatch(/xcodebuild/);
    expect(code).toMatch(/-scheme\s+Daak-macOS/);
    expect(code).toMatch(/\barchive\b/);
  });

  it('uses the fixed scratch derived-data path, not a per-attempt path', () => {
    // The host disk is nearly full. One path for each target reuses the cache.
    // A per-attempt path grows without bound and fills the disk, and a full
    // disk kills an Xcode build with no error message.
    // Exact, because `dd_macos` alone also matches `dd_macos-$RANDOM`.
    expect(code).toMatch(/DERIVED="\$SCRATCH\/dd_macos"/);
    // The archive command must use that fixed path.
    expect(code).toMatch(/-derivedDataPath/);
  });

  it('builds the image with hdiutil create and -format UDZO', () => {
    expect(code).toMatch(/hdiutil\s+create/);
    expect(code).toMatch(/-format\s+UDZO/);
  });

  it('verifies the app signature with codesign --verify', () => {
    expect(code).toMatch(/codesign\s+--verify/);
  });

  it('asserts the signing authority is Apple Development', () => {
    expect(code).toMatch(/Authority=Apple Development/);
  });

  it('reads the version from release/version.json', () => {
    expect(code).toMatch(/release\/version\.json/);
  });

  it('checks the version stamp before the build', () => {
    expect(code).toMatch(/stamp-version\.mjs --check/);
  });

  it('does not run notarytool, stapler, or a secure timestamp', () => {
    // No Developer ID certificate exists, so the app cannot be notarized. A
    // call to notarytool or stapler fails, because the secure timestamp server
    // is unreachable on this network.
    expect(code).not.toMatch(/notarytool/);
    expect(code).not.toMatch(/stapler/);
    expect(code).not.toMatch(/--timestamp/);
  });

  it('does not add the hardened runtime or a Sparkle feed', () => {
    // The entitlements do not grant the JIT entitlements. `--options runtime`
    // can crash the Hermes engine. The app does not use Sparkle updates.
    expect(code).not.toMatch(/--options\s+runtime/);
    expect(code).not.toMatch(/edSignature/);
  });
});
