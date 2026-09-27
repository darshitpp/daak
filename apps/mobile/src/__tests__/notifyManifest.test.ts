import { readFileSync } from 'fs';
import { join } from 'path';

// No JVM/Android test source set exists in this module and there is no Android
// SDK in CI, so the manifests are the parts of the notification path that can
// still be asserted here. Source-level pins, not behavioural tests: each one
// exists because the thing it guards is SILENT when wrong (a dropped
// notification, a module that is never registered).
const manifest = (p: string) => readFileSync(join(__dirname, p), 'utf8');

// __tests__ -> src -> mobile -> apps -> repo root.
const lib = manifest('../../../../modules/rn-notify/android/src/main/AndroidManifest.xml');
const app = manifest('../../android/app/src/main/AndroidManifest.xml');

describe('rn-notify Android manifest', () => {
  // R34: POST_NOTIFICATIONS is a RUNTIME permission on API 33+. Without this
  // entry requestPermissions can never grant, and a post with no grant is
  // silently dropped -- no error, no banner, nothing to debug from.
  it('declares POST_NOTIFICATIONS', () => {
    expect(lib).toMatch(/<uses-permission android:name="android\.permission\.POST_NOTIFICATIONS"/);
  });

  // A library cannot see the app's resources, so @style/Theme.Daak.* (what
  // the brief used) would not resolve at manifest-merge time. It has to be a
  // platform theme, and the activity must be private: it is not a share
  // target, and ShareTargetActivity in the app is the exported inbound one.
  it('registers the trampoline activity, privately and with no UI of its own', () => {
    const start = lib.indexOf('android:name=".ShareTrampolineActivity"');
    expect(start).toBeGreaterThan(-1);
    const block = lib.slice(start, lib.indexOf('/>', start));
    expect(block).toMatch(/android:exported="false"/);
    expect(block).toMatch(/android:theme="@android:style\//);
  });
});

describe('the notify path has no second send path', () => {
  // A cheap tripwire on the one rule that cannot be verified without a build.
  // presentShare is the only outbound thing the action wiring may name: no
  // engine.send, no sendText, no sendFiles, and no crypto.
  it('apps/mobile bootstrap names presentShare, not a transport', () => {
    const bootstrap = readFileSync(join(__dirname, '../bootstrap.ts'), 'utf8');
    const section = bootstrap.slice(bootstrap.indexOf('wireNotificationActions'));
    expect(section).toContain('presentShare');
    expect(section).not.toMatch(/engine\.send|sendText|sendFiles/);
  });
});

describe('App manifest', () => {
  // The library manifest supplies the permission and the trampoline, so the app
  // manifest must not need a second copy. Pinned so a future merge conflict is
  // visible here rather than at manifest-merger time.
  it('does not duplicate what the library manifest already declares', () => {
    expect(app).not.toMatch(/POST_NOTIFICATIONS/);
    expect(app).not.toMatch(/ShareTrampolineActivity/);
  });
});
