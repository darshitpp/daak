import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// No JVM/Android test source set exists in this module and there is no Android
// SDK in CI, so the manifests and the native sources are the parts of the
// notification path that can still be asserted here. Source-level pins, not
// behavioural tests: each one exists because the thing it guards is SILENT when
// wrong (a dropped notification, a module that is never registered, a button
// that does nothing).
const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');

// __tests__ -> src -> mobile -> apps -> repo root.
const lib = read('../../../../modules/rn-notify/android/src/main/AndroidManifest.xml');
const app = read('../../android/app/src/main/AndroidManifest.xml');
const buildGradlePath = '../../../../modules/rn-notify/android/build.gradle';
const gradleExists = existsSync(join(__dirname, buildGradlePath));
const gradle = gradleExists ? read(buildGradlePath) : '';

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(__dirname, dir))) {
    // node_modules holds a copy of react-native, which is not our source and
    // whose own vendored code would make this tripwire fire on nothing.
    if (name === 'node_modules' || name === 'Pods' || name === 'build') continue;
    const p = join(dir, name);
    if (statSync(join(__dirname, p)).isDirectory()) out.push(...sourcesUnder(p));
    else if (/\.(kt|swift|mm|ts)$/.test(name)) out.push(read(p));
  }
  return out;
}

const notifyNative = sourcesUnder('../../../../modules/rn-notify');
const appDelegate = read('../../ios/Daak/AppDelegate.mm');
const iosLaunchDelegate = existsSync(join(__dirname, '../../../../apps/mobile/ios/Daak/DaakNotificationDelegate.swift'))
  ? read('../../ios/Daak/DaakNotificationDelegate.swift')
  : '';
const iosModule = read('../../../../modules/rn-notify/ios/DaakNotify.swift');

describe('rn-notify Android library build', () => {
  // autolinkLibrariesFromCommand() requires an android/build.gradle per
  // library. Without one the module is never compiled, DaakNotify is never in
  // the TurboModule registry, getEnforcing throws at import -- and
  // packages/platform/src/index.ts re-exports ./notify at module scope, so the
  // whole app dies at startup. This is the identical Critical Task 4 shipped.
  it('has an android/build.gradle at all', () => {
    expect(gradleExists).toBe(true);
  });

  // Omitting the plugin means library codegen never registers, so
  // NativeDaakNotifySpec is never generated and nothing compiles. Also a Task 4
  // Critical, so it is pinned rather than trusted.
  it('applies com.facebook.react so codegen registers the library', () => {
    expect(gradle).toMatch(/apply plugin: 'com\.facebook\.react'/);
  });

  it('uses the notify namespace, minSdk 24 and a repositories block', () => {
    expect(gradle).toMatch(/namespace 'dev\.darshit\.daak\.notify'/);
    expect(gradle).toMatch(/minSdkVersion 24/);
    expect(gradle).toMatch(/^repositories \{ google\(\); mavenCentral\(\) \}/m);
  });
});

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

  // Every actionPending() PendingIntent is an EXPLICIT intent at
  // NotificationActionReceiver. A receiver that is not in the manifest cannot
  // be resolved by the system, so all three buttons are dead broadcasts and the
  // whole trampoline/stash path is unreachable. The previous version of this
  // pin named only the activity and MISSED this, so it is widened.
  it('registers NotificationActionReceiver, and privately', () => {
    const start = lib.indexOf('android:name=".NotificationActionReceiver"');
    expect(start).toBeGreaterThan(-1);
    const block = lib.slice(start, lib.indexOf('/>', start));
    // exported=false: the intents are explicit and intra-app only, so nothing
    // outside the app can start this receiver.
    expect(block).toMatch(/android:exported="false"/);
  });
});

describe('every registered action has a handler (R37)', () => {
  const notify = read('../../../../packages/platform/src/notify.ts');
  const match = /export const DAK_REGISTERED_ACTIONS = (\[[^\]]*\])/.exec(notify);
  // Single-quoted TS literals, not JSON, so the source under test is read as
  // written rather than reformatted to suit the assertion.
  const registered: string[] = match
    ? (match[1].match(/'([^']+)'/g) ?? []).map((q) => q.slice(1, -1))
    : [];

  // daak.folder has no reveal implementation on either platform, so a button
  // that does nothing is worse than no button: it is WITHHELD from the
  // installed category while staying in the frozen id vocabulary.
  it('does not register daak.folder while reveal is unimplemented', () => {
    expect(registered).toContain('daak.open');
    expect(registered).toContain('daak.share');
    expect(registered).not.toContain('daak.folder');
  });

  it('still keeps every id in the frozen vocabulary', () => {
    expect(notify).toMatch(/DAK_RECEIVED_ACTIONS = \['daak\.open', 'daak\.share', 'daak\.folder'\]/);
  });

  // Both platforms install their action lists independently of the TS one, so
  // neither may register a button the other has withheld.
  it('installs no daak.folder button on either platform', () => {
    for (const source of [iosModule, ...notifyNative]) {
      const buttons = source.match(/addAction\([^\n]*/g) ?? [];
      for (const line of buttons) expect(line).not.toMatch(/ACTION_FOLDER|daak\.folder/);
    }
    // iOS registers from its own (id, title) table. Comments are stripped so a
    // COMMENT that names the withheld id does not read as installing it.
    const raw = /actionTitles[^=]*= \[([\s\S]*?)\n  \]/.exec(iosModule)?.[1] ?? '';
    const table = raw
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    expect(table).not.toMatch(/daak\.folder/);
    expect(table).toMatch(/daak\.open/);
    expect(table).toMatch(/daak\.share/);
  });
});

describe('the notify module has no second send path', () => {
  // A cheap tripwire on the one rule that cannot be verified without a build.
  // Scoped to the WHOLE module, not one file: ShareTrampolineActivity is a
  // second chooser in Kotlin and a pin that reads only bootstrap.ts is silent
  // about it. `Intent.ACTION_SEND` is the OS sheet, not a transport, so only
  // engine/crypto/transport tokens are banned here.
  const transport =
    /engine\.send|sendText|sendFiles|uniffi|DaakEngine|\bTCP\b|chacha|Cipher|Ka|\.connect\(/;

  it('names no transport or crypto anywhere in modules/rn-notify', () => {
    for (const source of notifyNative) expect(source).not.toMatch(transport);
  });

  it('routes the JS action wiring through presentShare, not a transport', () => {
    const bootstrap = read('../bootstrap.ts');
    const section = bootstrap.slice(bootstrap.indexOf('wireNotificationActions'));
    expect(section).toContain('presentShare');
    expect(section).not.toMatch(/engine\.send|sendText|sendFiles/);
  });

  // The chooser in ShareTrampolineActivity duplicates DaakShare.present
  // because a BroadcastReceiver runs with no React context. That ceiling has
  // to be written down where the copy lives, or it drifts silently.
  it('names the duplication and its ceiling at the copy', () => {
    const trampoline = read(
      '../../../../modules/rn-notify/android/src/main/java/dev/darshit/daak/notify/ShareTrampolineActivity.kt',
    );
    expect(trampoline).toMatch(/ponytail:/);
    expect(trampoline).toMatch(/DaakShare/);
  });
});

describe('an un-listened emit falls through to the stash', () => {
  const module = read(
    '../../../../modules/rn-notify/android/src/main/java/dev/darshit/daak/notify/DaakNotifyModule.kt',
  );

  // reactContext is non-null from construction, so reporting `true` from it
  // alone claims delivery into nothing. A tapped action during the boot gap is
  // then silently lost -- the same defect R32 is about.
  it('gates emitToJs on a listener count, not on the context', () => {
    expect(module).toMatch(/listenerCount\s*>\s*0/);
    expect(module).toMatch(/override fun addListener\(eventName: String\)/);
    expect(module).toMatch(/override fun removeListeners\(count: Double\)/);
  });

  // Fire-and-forget: a process kill right after the tap loses the write, which
  // is the whole reason the stash exists.
  it('commits the stash write synchronously', () => {
    const stash = read(
      '../../../../modules/rn-notify/android/src/main/java/dev/darshit/daak/notify/NotifyStash.kt',
    );
    const put = stash.slice(stash.indexOf('fun put('), stash.indexOf('fun take('));
    expect(put).toMatch(/\.commit\(\)/);
    expect(put).not.toMatch(/\.apply\(\)/);
  });
});

describe('iOS cold-start action taps', () => {
  it('installs the notification delegate at app launch, not from JS', () => {
    expect(iosLaunchDelegate).not.toBe('');
    expect(iosLaunchDelegate).toMatch(/UNUserNotificationCenterDelegate/);
    expect(appDelegate).toMatch(/DaakNotificationDelegate/);
  });

  // registerCategories ran only after the bridge booted, so on a killed app the
  // delegate was nil and didReceive never fired at all.
  it('does not install the centre delegate from registerCategories', () => {
    const register = iosModule.slice(
      iosModule.indexOf('func registerCategories('),
      iosModule.indexOf('func post('),
    );
    expect(register).not.toMatch(/delegate\s*=/);
  });

  // An in-memory static cannot survive the gap between the tap and JS booting,
  // which is the whole case the stash exists for. The stash has to be on disk in
  // the App Group, written atomically like every other stager here.
  it('persists the stashed action in the App Group instead of memory only', () => {
    expect(iosLaunchDelegate).toMatch(/group\.dev\.darshit\.daak/);
    // Atomic write-then-rename on the FINAL path. The old tmp + fileExists +
    // replaceItemAt dance could leave the destination empty on a container
    // filesystem, which is the silent loss this file exists to prevent; the
    // atomic write is the same guarantee without the swap.
    expect(iosLaunchDelegate).toMatch(/\.write\(to: final, options: \.atomic\)/);
    expect(iosLaunchDelegate).not.toMatch(/replaceItemAt/);
    expect(iosModule).toMatch(/group\.dev\.darshit\.daak/);
    expect(iosModule).not.toMatch(/private static var stashed: String\?/);
  });

  // The readers live in the pod, not the app target. A second copy in the app
  // target is 19 duplicated lines that can drift without anything failing.
  it('keeps the stash readers in the pod only', () => {
    expect(iosLaunchDelegate).not.toMatch(/static func peek\(/);
    expect(iosLaunchDelegate).not.toMatch(/static func clear\(/);
  });

  // Two unsynchronised peek()-then-clear() blocks read ONE file from two
  // threads (module queue vs the Darwin posting thread), both peek before
  // either clears, and one tap opens the share sheet twice. Exactly one drain,
  // under exactly one lock, with both call sites routed through it.
  it('drains the App Group stash through one locked drain', () => {
    expect(iosModule).toMatch(/private static let stashLock = NSLock\(\)/);
    expect(iosModule.match(/DaakNotifyActionFile\.peek\(\)/g) ?? []).toHaveLength(1);
    expect(iosModule.match(/DaakNotifyActionFile\.clear\(\)/g) ?? []).toHaveLength(1);
    for (const fn of ['func consumePendingAction(', 'private func deliverStashed(']) {
      const start = iosModule.indexOf(fn);
      expect(start).toBeGreaterThan(-1);
      expect(iosModule.slice(start, iosModule.indexOf('\n  }', start))).toMatch(/drainStashed/);
    }
  });

  // deliverStashed is the path the stash exists for, so it must not clear a
  // value it could not deliver (no listener, or unparseable JSON).
  it('keeps the stash on disk when the emit path cannot deliver it', () => {
    expect(iosModule).toMatch(/if !json\.isEmpty && !keeping\(json\)/);
  });

  // UNUserNotificationCenterDelegate conformance lives in the app target, so a
  // willPresent note parked on DaakNotify is advice about a method the class
  // cannot implement.
  it('documents willPresent on the class that can implement it', () => {
    expect(iosModule).not.toMatch(/willPresent/);
    expect(iosLaunchDelegate).toMatch(/willPresent/);
  });

  // The Darwin name is duplicated on purpose (same precedent as the 3-way
  // dev.darshit.daak.share.inbox.changed), because the two targets cannot
  // import each other. A rename on one side is silent: the file is written and
  // nobody is woken, so the warm-app tap is delivered only by luck.
  it('uses an identical Darwin notification name in both targets', () => {
    const appSide = /static let changed = "([^"]+)"/.exec(iosLaunchDelegate)?.[1];
    const podSide = /static let actionChanged = "([^"]+)"/.exec(iosModule)?.[1];
    expect(appSide).toBeTruthy();
    expect(podSide).toBeTruthy();
    expect(appSide).toBe(podSide);
  });
});

describe('Android notify module state', () => {
  const module = read(
    '../../../../modules/rn-notify/android/src/main/java/dev/darshit/daak/notify/DaakNotifyModule.kt',
  );

  // A dev-bridge reload leaves the static counter above zero while the new
  // instance registers fresh listeners, so emitToJs can claim delivery into a
  // torn-down context and the tapped action is neither emitted nor stashed.
  it('clears the listener count in invalidate, not just the context', () => {
    const invalidate = module.slice(
      module.indexOf('override fun invalidate()'),
      module.indexOf('super.invalidate()'),
    );
    expect(invalidate).toMatch(/reactContext = null/);
    expect(invalidate).toMatch(/listenerCount = 0/);
  });

  // Nothing reads launch extras (MainActivity is a bare ReactActivity, no
  // onNewIntent, and bootstrap.ts never reads them), so putting them on the
  // content intent asserts a path that does not exist. A body tap and the Open
  // button are the same thing -- both open the app to the inbox -- and daak.open
  // is already wired end to end.
  it('puts no unreadable extras on the notification body intent', () => {
    const post = module.slice(
      module.indexOf('override fun post('),
      module.indexOf('override fun cancel('),
    );
    expect(post).not.toMatch(/putExtra\(EXTRA_/);
    expect(post).not.toMatch(/cold-start body tap reaches JS/);
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
