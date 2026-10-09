import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The release workflow publishes the draft GitHub Release when a version tag
// lands. It must not sign and it must not build. This host builds and signs
// the three artifacts. Ruling R27 keeps the Android keystore and the Apple
// certificate on this host. So the workflow holds no signing secret.
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

  it('grants contents: write, because a Release needs it', () => {
    expect(code).toMatch(/permissions:/);
    expect(code).toMatch(/contents:\s*write/);
  });

  it('fails the preflight when the tag does not match release/version.json', () => {
    expect(code).toMatch(/test\s+"v\$/);
    expect(code).toMatch(/release\/version\.json/);
  });

  it('creates the draft Release with the gh CLI', () => {
    expect(code).toMatch(/gh release create/);
    expect(code).toMatch(/--draft/);
  });

  it('does not hold a signing secret or a signing tool', () => {
    // The keystore and the Apple certificate stay on this host.
    expect(code).not.toMatch(/ANDROID_KEY/);
    expect(code).not.toMatch(/keystore/i);
    expect(code).not.toMatch(/base64/i);
    expect(code).not.toMatch(/notarytool/);
    expect(code).not.toMatch(/fastlane/);
    expect(code).not.toMatch(/altool/);
    expect(code).not.toMatch(/SPARKLE/);
    expect(code).not.toMatch(/MACOS_CERT/);
  });

  it('names only the GITHUB_TOKEN secret', () => {
    const secrets = code.match(/secrets\.[A-Za-z0-9_]+/g) ?? [];
    expect(secrets.length).toBeGreaterThan(0);
    expect(new Set(secrets)).toEqual(new Set(['secrets.GITHUB_TOKEN']));
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
