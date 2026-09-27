import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// No Xcode, no CocoaPods, no Android SDK/NDK and no Gradle on this host, so
// nothing native here can be compiled. These are source-level pins over the
// parts that are SILENT when wrong: a BG identifier that is not in
// Info.plist never runs, a second launch-time registration makes the no-op the
// handler, and a foreground service missing its API-34 permission throws the
// moment a transfer starts. Each pin below guards one of those.
const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');
const has = (p: string) => existsSync(join(__dirname, p));

/**
 * Drops // and /// line comments from a source file.
 *
 * Every source-level pin below asks "does this CODE call X?", but the files
 * also carry the rationale for why X is absent, and that rationale has to name
 * X to be useful. Grepping the whole file therefore fails on its own
 * documentation. Both line comments and /** *\/ doc blocks are removed. The
 * doc-block regex is intentionally non-greedy and must run FIRST: a naive
 * per-line strip leaves the interior of a doc block in place, and the pin that
 * motivated this helper failed exactly that way on the word useEffect.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
}
const repo = '../../../../';
const bg = repo + 'modules/rn-bgsched/';
// TWO prefixes, because there are two different bases in this file. `ktIn` is
// relative to `bg` and is used where a path is joined onto `bg`; `ktDir` is
// relative to the repo root and is used where a path is joined onto `repo`.
// One constant serving both silently resolves to the wrong directory, which is
// how the file-existence pin first failed with every Kotlin path "missing".
const ktIn = 'android/src/main/java/dev/darshit/daak/bgsched/';
const ktDir = bg + ktIn;

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(__dirname, dir))) {
    if (name === 'node_modules' || name === 'Pods' || name === 'build') continue;
    const p = join(dir, name);
    if (statSync(join(__dirname, p)).isDirectory()) out.push(...sourcesUnder(p));
    else if (/\.(kt|swift|mm|ts|gradle|xml|json)$/.test(name)) out.push(read(p));
  }
  return out;
}

const REFRESH = 'dev.darshit.daak.refresh';
const PROCESSING = 'dev.darshit.daak.processing';

describe('rn-bgsched has the full rn-share shape', () => {
  // The exact omissions that killed Task 4 (no build.gradle) and Task 8 (no
  // package class). Both compile fine everywhere else and only fail at boot.
  it('has every file rn-share has', () => {
    for (const f of [
      'package.json',
      'js/NativeDaakBgSched.ts',
      'js/index.ts',
      'ios/DaakBgSched.swift',
      'ios/DaakBgSched.mm',
      'ios/DaakBgSched.podspec',
      'android/build.gradle',
      'android/src/main/AndroidManifest.xml',
      ktIn + 'DaakBgSchedModule.kt',
      ktIn + 'DaakBgSchedPackage.kt',
      ktIn + 'DaakSyncService.kt',
      ktIn + 'DaakDrainWorker.kt',
    ]) {
      expect(has(bg + f)).toBe(true);
    }
  });

  it('applies com.facebook.react so codegen registers the library', () => {
    const gradle = read(bg + 'android/build.gradle');
    expect(gradle).toMatch(/apply plugin: 'com\.facebook\.react'/);
    expect(gradle).toMatch(/minSdkVersion 24/);
    expect(gradle).toContain("namespace 'dev.darshit.daak.bgsched'");
  });

  // R44: a getEnforcing<any> loses every type error the Spec exists to catch.
  it('types the TurboModule by its Spec, never getEnforcing<any>', () => {
    const spec = read(bg + 'js/NativeDaakBgSched.ts');
    expect(spec).toMatch("TurboModuleRegistry.getEnforcing<Spec>('DaakBgSched')");
    expect(spec).not.toMatch(/getEnforcing<any>/);
    expect(spec).toMatch(/export interface Spec extends TurboModule/);
  });

  it('declares a BaseReactPackage that returns the module by name', () => {
    const pkg = read(ktDir + 'DaakBgSchedPackage.kt');
    expect(pkg).toMatch(/class \w+Package : BaseReactPackage\(\)/);
    expect(pkg).toMatch(/isTurboModule = \*\/ true/);
  });
});

describe('the two BG identifiers', () => {
  // iOS REFUSES to submit a task whose identifier is not in
  // BGTaskSchedulerPermittedIdentifiers, and the launch-time register() is a
  // silent no-op for one that is not in the Info.plist either. Three files
  // cannot import each other (TS, XML, app-target Swift), so the literal is
  // duplicated three times and pinned equal here. A rename on one side is
  // otherwise invisible until a background slot never fires.
  it('are the exact required ids in TS, Info.plist and the launch registrar', () => {
    const ts = read(repo + 'packages/platform/src/bgsched.ts');
    const plist = read(repo + 'apps/mobile/ios/Daak/Info.plist');
    const launch = read(repo + 'apps/mobile/ios/Daak/DaakBgLaunch.swift');
    expect(ts).toContain("'" + REFRESH + "'");
    expect(ts).toContain("'" + PROCESSING + "'");
    expect(plist).toContain('<string>' + REFRESH + '</string>');
    expect(plist).toContain('<string>' + PROCESSING + '</string>');
    expect(launch).toContain('"' + REFRESH + '"');
    expect(launch).toContain('"' + PROCESSING + '"');
  });

  it('permits exactly those two in Info.plist, with the background modes', () => {
    const plist = read(repo + 'apps/mobile/ios/Daak/Info.plist');
    const idsKey = plist.indexOf('<key>BGTaskSchedulerPermittedIdentifiers</key>');
    const ids = plist.slice(idsKey, plist.indexOf('</array>', idsKey));
    expect([...ids.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1])).toEqual([
      REFRESH,
      PROCESSING,
    ]);
    const modesKey = plist.indexOf('<key>UIBackgroundModes</key>');
    const modes = plist.slice(modesKey, plist.indexOf('</array>', modesKey));
    expect(modes).toContain('<string>fetch</string>');
    expect(modes).toContain('<string>processing</string>');
  });
});

describe('exactly ONE owner registers the iOS launch handlers', () => {
  // The plan registers both identifiers TWICE: once in AppDelegate with empty
  // closures, once in the module. BGTaskScheduler keeps the FIRST registration
  // and ignores the rest, so the plan's shape makes the AppDelegate no-op the
  // real handler and the module's body is dead code that reads as working.
  //
  // The registrar is the APP TARGET, not the pod, for the reason R32 already
  // paid for on notifications: iOS launches the process for a BGTask and the
  // TurboModule does not exist until the bridge has booted, so a pod-side
  // registration misses exactly the cold launch it exists for. Same shape as
  // DaakNotificationDelegate, for the same reason.
  it('registers in the app-target launch file and nowhere else', () => {
    const launch = read(repo + 'apps/mobile/ios/Daak/DaakBgLaunch.swift');
    // `refreshId` bare, not `Self.refreshId`: both are valid Swift for a static
    // member inside the same type, and pinning one spelling rejects the other
    // for no reason. The invariant is that BOTH identifiers are registered, and
    // that the pod does not register anything.
    expect(launch).toMatch(
      /BGTaskScheduler\.shared\.register\(\s*forTaskWithIdentifier:\s*(Self\.)?refreshId/,
    );
    expect(launch).toMatch(
      /BGTaskScheduler\.shared\.register\(\s*forTaskWithIdentifier:\s*(Self\.)?processingId/,
    );
    const pod = read(bg + 'ios/DaakBgSched.swift');
    expect(pod).not.toMatch(/BGTaskScheduler\.shared\.register/);
    const delegate = read(repo + 'apps/mobile/ios/Daak/AppDelegate.mm');
    expect(delegate).toMatch(/DaakBgLaunch/);
  });

  // A submitted request with no registered handler is never delivered, and the
  // refresh chain dies after one run unless the handler resubmits. Both halves
  // are silent.
  it('resubmits the next refresh from inside the handler', () => {
    const launch = read(repo + 'apps/mobile/ios/Daak/DaakBgLaunch.swift');
    const start = launch.indexOf('private static func handle(');
    const handler = launch.slice(start, launch.indexOf('private static func scheduleRefresh('));
    expect(start).toBeGreaterThan(-1);
    expect(handler).toMatch(/setTaskCompleted\(success: true\)/);
    expect(handler).toMatch(/scheduleRefresh\(\)/);
  });

  // The launch handler runs in a process whose JS may not be up, so it must not
  // depend on it. It completes the task and lets the engine's own outbox ticker
  // (see the GAP 1 pin below) do the drain.
  it('completes the task and touches no JS, no engine and no shared holder', () => {
    // Comments are stripped first: a rationale that says WHY the handler is
    // JS-free necessarily contains the words "bridge" and "rn-bgsched", and a
    // regex over prose forbids documentation. This pins the code only.
    const launch = stripComments(read(repo + 'apps/mobile/ios/Daak/DaakBgLaunch.swift'));
    expect(launch).not.toMatch(/DaakBgSched|bridge|RCTEventEmitter|emitEvent/);
  });
});

describe('the Android foreground service', () => {
  const libManifest = read(bg + 'android/src/main/AndroidManifest.xml');
  const service = read(ktDir + 'DaakSyncService.kt');

  // Without this entry the system cannot resolve the explicit
  // ContextCompat.startForegroundService intent, so every transfer runs
  // unnotified and the OS kills it on a long send.
  it('is registered, private, and typed dataSync', () => {
    const start = libManifest.indexOf('android:name=".DaakSyncService"');
    expect(start).toBeGreaterThan(-1);
    const block = libManifest.slice(start, libManifest.indexOf('/>', start));
    expect(block).toMatch(/android:exported="false"/);
    expect(block).toMatch(/android:foregroundServiceType="dataSync"/);
  });

  // API 34+ THROWS ForegroundServiceStartException if a dataSync service starts
  // without this permission. minSdk is 24 and the permission is a normal one,
  // so it is declared unconditionally in the library manifest.
  it('declares FOREGROUND_SERVICE_DATA_SYNC, which API 34+ enforces', () => {
    expect(libManifest).toMatch(
      /<uses-permission android:name="android\.permission\.FOREGROUND_SERVICE_DATA_SYNC"/,
    );
  });

  // R34 again: the channel must EXIST before startForeground on API 26+ or the
  // notification is silently dropped, and IMPORTANCE_LOW is the whole point --
  // an active transfer must not make a sound.
  it('creates a low-importance channel behind an API 26 guard', () => {
    // Direction is not the point, the GUARD is: either comparison proves the
    // channel creation is behind an SDK_INT check, and pinning one direction
    // would reject the equally valid other one for no reason.
    expect(service).toMatch(/Build\.VERSION\.SDK_INT\s*[<>]=?\s*Build\.VERSION_CODES\.O/);
    expect(service).toMatch(/NotificationManager\.IMPORTANCE_LOW/);
    expect(service).toMatch(/startForeground\(/);
  });

  // The whole point of the service is to hold the process alive while a
  // transfer runs. It must NOT claim to drain anything (GAP 1).
  it('holds the process up and drains nothing', () => {
    expect(service).not.toMatch(/DaakEngineHolder|\.drain\(|uniffi|engine\.send/);
  });
});

describe('the WorkManager drain wake', () => {
  const worker = read(ktDir + 'DaakDrainWorker.kt');

  // A periodic worker that starts a foreground service unconditionally puts a
  // notification in the tray every 15 minutes forever. It may only re-raise
  // the service when a transfer is actually in flight.
  it('re-raises the service only while a transfer is in flight', () => {
    expect(worker).toMatch(/isTransferActive\(/);
    expect(worker).toMatch(/DaakSyncService\.start\(/);
    expect(worker).toMatch(/Result\.success\(\)/);
  });

  it('drains nothing and reaches no engine', () => {
    expect(worker).not.toMatch(/DaakEngineHolder|\.drain\(|uniffi|DaakEngine/);
  });
});

describe('GAP 1: nothing invented a drain entry point', () => {
  // There is no DaakEngineHolder anywhere in this repo and never has been, and
  // no drain() on the engine. The outbox worker already drains itself: a 5s
  // ticker plus notify_peer_online from enqueue_outbox_send and from presence.
  // A background wake therefore only has to WAKE, and adding a drain() would
  // race that ticker for the same rows.
  it('names no DaakEngineHolder and no drain() in any source', () => {
    for (const source of [
      ...sourcesUnder(repo + 'modules/rn-bgsched'),
      read(repo + 'apps/mobile/src/bootstrap.ts'),
      read(repo + 'apps/mobile/ios/Daak/DaakBgLaunch.swift'),
    ]) {
      expect(source).not.toMatch(/DaakEngineHolder|\.drain\(/);
    }
  });
});

describe('GAP 2: no backgroundWake engine method was invented', () => {
  // R4 already ruled that backgroundWake arrives in Phase 7 Task 3. Adding it
  // here would be a UDL + wire change nobody specced for this phase, on a
  // packages/core interface that is FROZEN for both the in-process engine and
  // the daemon client.
  it('appears in no source and not on the engine interface', () => {
    for (const source of [
      ...sourcesUnder(repo + 'modules/rn-bgsched'),
      read(repo + 'apps/mobile/src/bootstrap.ts'),
      read(repo + 'packages/platform/src/bgsched.ts'),
    ]) {
      expect(source).not.toMatch(/backgroundWake/);
    }
    expect(read(repo + 'packages/core/src/engine/types.ts')).not.toMatch(/backgroundWake/);
  });
});

describe('the module gained no send path', () => {
  const transport =
    /engine\.send|sendText|sendFiles|uniffi|DaakEngine|\bTCP\b|chacha|Cipher|\.connect\(/;

  it('names no transport or crypto anywhere in modules/rn-bgsched', () => {
    for (const source of sourcesUnder(repo + 'modules/rn-bgsched')) {
      expect(source).not.toMatch(transport);
    }
  });
});

describe('the battery-optimisation prompt is reachable, and only on a tap', () => {
  // requestBatteryExemption opens SYSTEM settings. It has to be reachable from
  // a screen, and it has to be reachable only from a press handler -- never
  // from an effect. These three pins hold all three facts at once.
  it('is rendered by the Settings screen', () => {
    const screen = read(repo + 'packages/ui/src/screens/SettingsScreen.tsx');
    expect(screen).toMatch(/BackgroundSyncNotice/);
  });

  it('only ever calls it from a press handler', () => {
    const notice = read(repo + 'apps/mobile/src/BackgroundSyncNotice.tsx');
    const code = stripComments(notice);
    expect(code).toMatch(/onPress/);
    // No effect of any kind: requestBatteryExemption navigates away from the
    // app, so an effect would eject the user from Daak on first open with no
    // gesture and no explanation. Comments are stripped first because the
    // component's own rationale necessarily names useEffect.
    expect(code).not.toMatch(/useEffect|useLayoutEffect|componentDidMount/);
  });

  // App.tsx owns the lifecycle, but it owns it through the IDEMPOTENT wrapper
  // and nothing else. Calling startEngine directly would let a StrictMode
  // double-invoke or a Fast Refresh build a second engine -- two identities and
  // two discovery stacks on one LAN. And App must never touch background
  // scheduling directly: initBackgroundSync belongs to startEngine, so a
  // second call here would book duplicate slots.
  it('starts the engine only through the idempotent owner', () => {
    const app = read(repo + 'apps/mobile/src/App.tsx');
    const code = stripComments(app);
    expect(code).not.toMatch(/initBackgroundSync/);
    expect(code).toMatch(/startEngineOnce/);
    // startEngineOnce(...) is fine; a bare startEngine( is not.
    expect(code).not.toMatch(/[^e]startEngine\(/);
  });
});
