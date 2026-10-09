import { readFileSync } from 'fs';
import { join } from 'path';

// The Android floor is 8.0, API 26. The Phase 5 plan sets it and asks every
// packaging job to assert it (discrepancy D-A8). The app declared 24, so the APK
// installed on Android 7, which nobody tested. The floor lives in the root
// build.gradle and in every native module; one module left at 24 would lower the
// merged manifest again, so the pin covers all of them.
const repo = '../../../../';
const read = (p: string) => readFileSync(join(__dirname, repo, p), 'utf8');

const FLOOR = 26;
const modules = [
  'rn-bgsched',
  'rn-clipboard',
  'rn-fspaths',
  'rn-notify',
  'rn-qrscanner',
  'rn-securestore',
  'rn-share',
];

describe('the Android minSdk floor', () => {
  it('is 26 in the root build.gradle', () => {
    const m = /minSdkVersion\s*=\s*(\d+)/.exec(read('apps/mobile/android/build.gradle'));
    expect(Number(m?.[1])).toBe(FLOOR);
  });

  it.each(modules)('is 26 in the %s module', (name) => {
    const m = /minSdkVersion\s+(\d+)/.exec(read(`modules/${name}/android/build.gradle`));
    expect(Number(m?.[1])).toBe(FLOOR);
  });

  it('is asserted by the signing script on every APK it writes', () => {
    const script = read('scripts/sign-android.sh');
    expect(script).toMatch(/aapt/);
    expect(script).toMatch(/sdkVersion:'26'/);
  });
});
