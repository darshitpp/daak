import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The release workflow creates the draft GitHub Release when a version tag
// lands. A manual run also builds the Android APKs and signs them. Only the job
// android-sign holds the Android upload key, and it runs in the environment
// release (decision of 2026-10-15, which replaces ruling R27 for Android). The
// Apple certificate stays on this host. So no job holds an Apple secret.
//
// The workflow carries a required comment block. That block names the
// keystore and the Apple certificate. A raw scan over the unstripped file
// would match its own prose. So the code assertions below read the source
// with the YAML comments removed.
function stripYamlComments(source: string): string {
  return source
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n');
}

const workflow = join(__dirname, '..', '..', '..', '.github', 'workflows', 'release.yml');

describe('the release workflow', () => {
  const exists = existsSync(workflow);
  const source = exists ? readFileSync(workflow, 'utf8') : '';
  const code = stripYamlComments(source);

  it('exists', () => {
    expect(exists).toBe(true);
  });

  it('triggers on a push of a v* tag', () => {
    expect(code).toMatch(/^on:/m);
    expect(code).toMatch(/push:/);
    expect(code).toMatch(/tags:/);
    expect(code).toMatch(/v\*/);
  });

  it('grants contents: write to the draft job only, because only a Release needs it', () => {
    expect(code).toMatch(/^permissions:\s*\n\s+contents: read/m);
    const draft = code.slice(code.indexOf('  draft:'));
    expect(draft).toMatch(/permissions:\s*\n\s+contents:\s*write/);
    expect(code.slice(0, code.indexOf('  draft:'))).not.toMatch(/contents:\s*write/);
  });

  it('fails the preflight when the tag does not match release/version.json', () => {
    expect(code).toMatch(/test\s+"v\$/);
    expect(code).toMatch(/release\/version\.json/);
  });

  it('creates the draft Release with the gh CLI', () => {
    expect(code).toMatch(/gh release create/);
    expect(code).toMatch(/--draft/);
  });

  // android-sign is the last job in the file.
  const signAt = code.indexOf('  android-sign:');
  const beforeSign = code.slice(0, signAt);
  const signJob = code.slice(signAt);

  it('holds no Apple secret and no Apple signing tool', () => {
    expect(code).not.toMatch(/notarytool/);
    expect(code).not.toMatch(/fastlane/);
    expect(code).not.toMatch(/altool/);
    expect(code).not.toMatch(/SPARKLE/);
    expect(code).not.toMatch(/MACOS_CERT/);
  });

  it('keeps the Android key out of every job except android-sign', () => {
    expect(signAt).toBeGreaterThan(0);
    expect(beforeSign).not.toMatch(/ANDROID_KEY/);
    expect(beforeSign).not.toMatch(/keystore/i);
    expect(beforeSign).not.toMatch(/base64/i);
    expect(beforeSign).not.toMatch(/apksigner/);
  });

  it('names only the GITHUB_TOKEN secret outside android-sign', () => {
    const secrets = beforeSign.match(/secrets\.[A-Za-z0-9_]+/g) ?? [];
    expect(secrets.length).toBeGreaterThan(0);
    expect(new Set(secrets)).toEqual(new Set(['secrets.GITHUB_TOKEN']));
  });

  it('gives android-sign exactly the two Android secrets, in the environment release', () => {
    const secrets = signJob.match(/secrets\.[A-Za-z0-9_]+/g) ?? [];
    expect(new Set(secrets)).toEqual(
      new Set(['secrets.ANDROID_KEYSTORE_BASE64', 'secrets.ANDROID_KEYSTORE_PASSWORD']),
    );
    expect(signJob).toMatch(/^\s+environment: release$/m);
  });

  it('signs so that F-Droid can copy the signature onto its own APK', () => {
    // A v1 signature adds zip entries. A new alignment moves them. Either one
    // breaks the apksigcopier check of fdroid build.
    expect(signJob).toMatch(/--v1-signing-enabled false/);
    expect(signJob).toMatch(/--alignment-preserved/);
  });

  it('never checks out the repository in android-sign', () => {
    expect(signJob).not.toMatch(/actions\/checkout/);
  });

  it('does not call a reusable _*.yml workflow', () => {
    expect(code).not.toMatch(/\.github\/workflows\/_/);
    expect(code).not.toMatch(/_(android|ios|macos|windows|linux)\.yml/);
  });
});

describe('the CI workflow', () => {
  const ci = readFileSync(
    join(__dirname, '..', '..', '..', '.github', 'workflows', 'ci.yml'),
    'utf8',
  );

  it('grants the token read access only', () => {
    expect(stripYamlComments(ci)).toMatch(/^permissions:\s*\n\s+contents: read/m);
  });
});

describe('every workflow action', () => {
  const dir = join(__dirname, '..', '..', '..', '.github', 'workflows');

  it('is pinned to a full commit SHA', () => {
    for (const file of ['ci.yml', 'release.yml']) {
      const code = stripYamlComments(readFileSync(join(dir, file), 'utf8'));
      const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
      expect(uses.length).toBeGreaterThan(0);
      for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});
