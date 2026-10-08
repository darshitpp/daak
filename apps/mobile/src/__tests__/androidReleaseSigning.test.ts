import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// The Android release signing wiring has no runtime test. The JavaScript unit
// suite is the only CI gate that reads it, so this file pins the four
// decisions that make a signed release APK possible: the ignore rule, the
// example properties file, the Gradle read, and the release-only signing
// config.
//
// The stakes are asymmetric. A missing signature is loud. A release APK signed
// with the DEBUG key is silent at build time and the user only learns of it on
// the first update, when the update key no longer matches the installed key.
// So the release build type must never inherit `signingConfigs.debug`.
//
// Every assertion strips comments first, as the other source pins in this repo
// do. These files carry long why-comments that name the very strings under
// test, so a raw match would pass on a comment alone.
const repo = '../../../../';
const read = (p: string) => readFileSync(join(__dirname, repo, p), 'utf8');
const stripComments = (s: string): string =>
  // Line comments only, as the other pins here do. A `/* ... */` strip also
  // eats the `/**' , '**/` inside the Gradle glob strings, which is worse than
  // the comment it removes. Every comment that names a pinned string is a
  // line comment, so this is enough.
  s.replace(/[ \t]*\/\/[^\n]*/g, '').replace(/[ \t]*#[^\n]*/g, '');

// Brace-balanced slice of one Groovy block, so a nested `if { ... }` inside a
// build type cannot end the match early.
const block = (source: string, header: RegExp): string | undefined => {
  const m = header.exec(source);
  if (!m) return undefined;
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(m.index, i + 1);
    }
  }
  return undefined;
};

const rootGitignore = '.gitignore';
const example = 'apps/mobile/android/keystore.properties.example';
const appGradle = 'apps/mobile/android/app/build.gradle';

describe('Android release signing', () => {
  it('ignores keystore.properties and every .jks in the root .gitignore', () => {
    const gi = stripComments(read(rootGitignore));
    expect(gi).toMatch(/^apps\/mobile\/android\/keystore\.properties[ \t]*$/m);
    expect(gi).toMatch(/^\*\.jks[ \t]*$/m);
  });

  it('documents the four keys and the real keystore path in the example', () => {
    expect(existsSync(join(__dirname, repo, example))).toBe(true);
    const text = stripComments(read(example));
    for (const key of ['storeFile', 'storePassword', 'keyAlias', 'keyPassword']) {
      expect(text).toMatch(new RegExp(`^${key}=`, 'm'));
    }
    expect(text).toMatch(/^storeFile=.*daak-upload\.jks[ \t]*$/m);
  });

  it('reads keystore.properties, then the four environment variables', () => {
    const gradle = stripComments(read(appGradle));
    expect(gradle).toMatch(/file\(\s*['"]keystore\.properties['"]\s*\)/);
    expect(gradle).toMatch(/\.load\(/);
    for (const key of ['storeFile', 'storePassword', 'keyAlias', 'keyPassword']) {
      expect(gradle).toMatch(new RegExp(`getProperty\\(\\s*['"]${key}['"]\\s*\\)`));
    }
    for (const env of [
      'ANDROID_KEYSTORE_PATH',
      'ANDROID_KEYSTORE_PASSWORD',
      'ANDROID_KEY_ALIAS',
      'ANDROID_KEY_PASSWORD',
    ]) {
      expect(gradle).toMatch(new RegExp(`getenv\\(\\s*['"]${env}['"]\\s*\\)`));
    }

    // The reads above are not the pin. The release signing block must CONSUME
    // the resolved values, or the reads can be left in place and disconnected
    // while the release APK is signed with anything. Each assertion names the
    // resolved variable the read assigns, so a literal in the signing block
    // fails here even though every getProperty/getenv above still matches.
    const signingConfigs = block(gradle, /signingConfigs\s*\{/);
    const release = signingConfigs && block(signingConfigs, /release\s*\{/);
    expect(release).toBeTruthy();
    expect(release).toMatch(/storeFile\s+file\(\s*releaseStoreFile\s*\)/);
    expect(release).toMatch(/storePassword\s+releaseStorePassword/);
    expect(release).toMatch(/keyAlias\s+releaseKeyAlias/);
    expect(release).toMatch(/keyPassword\s+releaseKeyPassword/);
  });

  it('defines a release signing config and applies it to the release build type', () => {
    const gradle = stripComments(read(appGradle));
    const signingConfigs = block(gradle, /signingConfigs\s*\{/);
    expect(signingConfigs).toBeTruthy();
    const releaseConfig = signingConfigs && block(signingConfigs, /release\s*\{/);
    expect(releaseConfig).toBeTruthy();
    expect(releaseConfig).toMatch(/storeFile/);
    expect(releaseConfig).toMatch(/storePassword/);
    expect(releaseConfig).toMatch(/keyAlias/);
    expect(releaseConfig).toMatch(/keyPassword/);

    const buildTypes = block(gradle, /buildTypes\s*\{/);
    expect(buildTypes).toBeTruthy();
    const releaseType = buildTypes && block(buildTypes, /release\s*\{/);
    expect(releaseType).toMatch(/signingConfig\s+signingConfigs\.release/);
  });

  it('never applies the release signing config to the debug build type', () => {
    const gradle = stripComments(read(appGradle));
    const buildTypes = block(gradle, /buildTypes\s*\{/);
    expect(buildTypes).toBeTruthy();
    const debugType = buildTypes && block(buildTypes, /debug\s*\{/);
    expect(debugType).toBeTruthy();
    expect(debugType).toMatch(/signingConfig\s+signingConfigs\.debug/);
    expect(debugType).not.toMatch(/signingConfigs\.release/);
  });
});
