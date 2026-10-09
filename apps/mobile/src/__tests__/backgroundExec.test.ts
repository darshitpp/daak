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
    // Comments are stripped here too, for the reason the `handle` slice used to
    // be prose-matchable: a NEGATIVE pin over unstripped text forbids the file
    // from DOCUMENTING the thing it must not do, which is the opposite of what
    // these pins are for. All of them read "does this CODE ...?", so none of
    // them may ever look at a comment.
    else if (/\.(kt|swift|mm|ts|gradle|xml|json)$/.test(name)) out.push(stripComments(read(p)));
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
    const gradle = stripComments(read(bg + 'android/build.gradle'));
    expect(gradle).toMatch(/apply plugin: 'com\.facebook\.react'/);
    expect(gradle).toMatch(/minSdkVersion 26/);
    expect(gradle).toContain("namespace 'dev.darshit.daak.bgsched'");
  });

  // R44: a getEnforcing<any> loses every type error the Spec exists to catch.
  it('types the TurboModule by its Spec, never getEnforcing<any>', () => {
    const spec = stripComments(read(bg + 'js/NativeDaakBgSched.ts'));
    expect(spec).toMatch("TurboModuleRegistry.getEnforcing<Spec>('DaakBgSched')");
    expect(spec).not.toMatch(/getEnforcing<any>/);
    expect(spec).toMatch(/export interface Spec extends TurboModule/);
  });

  it('declares a BaseReactPackage that returns the module by name', () => {
    const pkg = stripComments(read(ktDir + 'DaakBgSchedPackage.kt'));
    expect(pkg).toMatch(/class \w+Package : BaseReactPackage\(\)/);
    // REWRITTEN, not loosened. The old regex literally required the text
    // `isTurboModule = */ true` -- i.e. it required the KDoc comment saying so,
    // and passed whether or not the module said it in CODE. ReactModuleInfo's
    // signature is positional, so isTurboModule is the last of its six flags
    // and is what this pins: a trailing `true` as the sixth argument.
    // The five boolean flags in order, so the LAST one -- isTurboModule -- is
    // the one asserted. Written out positionally because that is how the
    // constructor takes them; there is no named argument to grep for.
    expect(pkg).toMatch(
      /false,\s*\n\s*false,\s*\n\s*false,\s*\n\s*true,/,
    );
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
    const ts = stripComments(read(repo + 'packages/platform/src/bgsched.ts'));
    const plist = stripComments(read(repo + 'apps/mobile/ios/Daak/Info.plist'));
    const launch = stripComments(read(repo + 'apps/mobile/ios/Daak/DaakBgLaunch.swift'));
    expect(ts).toContain("'" + REFRESH + "'");
    expect(ts).toContain("'" + PROCESSING + "'");
    expect(plist).toContain('<string>' + REFRESH + '</string>');
    expect(plist).toContain('<string>' + PROCESSING + '</string>');
    expect(launch).toContain('"' + REFRESH + '"');
    expect(launch).toContain('"' + PROCESSING + '"');
  });

  it('permits exactly those two in Info.plist, with the background modes', () => {
    const plist = stripComments(read(repo + 'apps/mobile/ios/Daak/Info.plist'));
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
    const launch = stripComments(read(repo + 'apps/mobile/ios/Daak/DaakBgLaunch.swift'));
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
    const pod = stripComments(read(bg + 'ios/DaakBgSched.swift'));
    expect(pod).not.toMatch(/BGTaskScheduler\.shared\.register/);
    const delegate = stripComments(read(repo + 'apps/mobile/ios/Daak/AppDelegate.mm'));
    expect(delegate).toMatch(/DaakBgLaunch/);
  });

  // A submitted request with no registered handler is never delivered, and the
  // refresh chain dies after one run unless the handler resubmits. Both halves
  // are silent.
  it('resubmits the next refresh from inside the handler', () => {
    // stripComments is the whole point of this slice. The handler's own
    // rationale has to SAY that it resubmits, so an unstripped grep over this
    // body is satisfied by that sentence: commenting out the reschedule left
    // 147/147 green with the iOS refresh chain severed (review Critical 3).
    // Every slice in this file strips for the same reason.
    // The slice is bounded by the DOC-COMPLETED text, and both bounds are
    // asserted. A bound that resolves to -1 makes slice() run to EOF, which
    // satisfies every later toMatch from the REST OF THE FILE -- the mode the
    // reviewer's first mutation attempt hit, and the mode my own KDoc edit
    // reintroduced while writing this test. Asserting end > start is what makes
    // that unpassable rather than silently green.
    const launch = stripComments(read(repo + 'apps/mobile/ios/Daak/DaakBgLaunch.swift'));
    const start = launch.indexOf('private static func handle(_ task: BGTask) {');
    const end = launch.indexOf('@objc static func scheduleRefresh() {');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const handler = launch.slice(start, end);
    expect(handler).toMatch(/setTaskCompleted\(success: true\)/);
    expect(handler).toMatch(/scheduleRefresh\(\)/);
  });

  // A submitted request is what buys a launch, and the launch is what buys the
  // next submission. A submit that lives ONLY inside the granted handler has
  // no producer for the first request, so the schedule never starts at all:
  // no submit -> no grant -> no handler -> no submit (review Critical 1). The
  // first submit therefore has to happen OUTSIDE handle(), at install time.
  it('books the first request from install, not from inside the handler', () => {
    const launch = stripComments(read(repo + 'apps/mobile/ios/Daak/DaakBgLaunch.swift'));
    const start = launch.indexOf('@objc static func install() {');
    const end = launch.indexOf('private static var registeredRefresh');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const install = launch.slice(
      start,
      end,
    );
    expect(install).toMatch(/scheduleRefresh\(\)/);
    // C2: dev.darshit.daak.processing is registered and permitted, so iOS
    // would accept a request for it -- and nothing ever submitted one, so the
    // plan's scheduleProcessing(15 * 60) computed a number and dropped it.
    expect(install).toMatch(/scheduleProcessing\(\)/);
  });

  // Both request KINDS must exist. A handler that only ever submits a refresh
  // is a working chain, so a green reschedule pin alone cannot prove this.
  it('submits a request of each kind, with no OS precondition set', () => {
    const launch = stripComments(read(repo + 'apps/mobile/ios/Daak/DaakBgLaunch.swift'));
    expect(launch).toMatch(/BGAppRefreshTaskRequest\(identifier: refreshId\)/);
    expect(launch).toMatch(/BGProcessingTaskRequest\(identifier: processingId\)/);
    // Daak is LAN-only, so requiresNetworkConnectivity would mean "has a LAN
    // peer", which is a peer question and not an OS one; the OS can only
    // answer about the internet. Both preconditions stay false (the plan's
    // values) and are pinned off so a later reader cannot "fix" them to true.
    expect(launch).not.toMatch(/requiresNetworkConnectivity = true|requiresExternalPower = true/);
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
  const libManifest = stripComments(read(bg + 'android/src/main/AndroidManifest.xml'));
  const service = stripComments(read(ktDir + 'DaakSyncService.kt'));

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
  // without this permission. minSdk is 26 and the permission is a normal one,
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
  const worker = stripComments(read(ktDir + 'DaakDrainWorker.kt'));

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
      stripComments(read(repo + 'apps/mobile/src/bootstrap.ts')),
      stripComments(read(repo + 'apps/mobile/ios/Daak/DaakBgLaunch.swift')),
    ]) {
      expect(source).not.toMatch(/DaakEngineHolder|\.drain\(/);
    }
  });
});

describe('the iOS grant record is real and is the only field set', () => {
  // The spike records what iOS actually hands the handler. Every measurement
  // run writes one line per delivery, and a run that measured nothing is
  // indistinguishable from a chain that never fired unless the append is
  // pinned to the handler body.
  it('appends one jsonl line per delivery from inside the handler', () => {
    const launch = stripComments(read(repo + 'apps/mobile/ios/Daak/DaakBgLaunch.swift'));
    const start = launch.indexOf('private static func handle(_ task: BGTask) {');
    const end = launch.indexOf('@objc static func scheduleRefresh() {');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    // A CALL, not a bare name: `appendSpikeLine(taskId: task.identifier` is
    // the only form with arguments, so the declaration of the function below
    // cannot satisfy it. The bare-name form this replaced survived deleting the
    // only call in handle, because the `end` bound sits AFTER the declaration
    // and the slice therefore contained the function's own signature.
    expect(launch.slice(start, end)).toMatch(/appendSpikeLine\(taskId: task\.identifier/);
    expect(launch).toContain('"grantedMs"');
    expect(launch).toContain('group.dev.darshit.daak');
  });

  // R127: the plan's wakeEngine stub posted a Notification nobody observed and
  // returned a hard-coded 0 for `drained`, so a 24 h run would have reported a
  // passing background-drain measurement that never happened. The two drain
  // fields are therefore NOT written by the producer, and the pass criterion
  // that reads them is structurally unreachable until Phase 7 Task 3.
  it('writes no dueAtStart or drained field, and fakes no drain', () => {
    const launch = stripComments(read(repo + 'apps/mobile/ios/Daak/DaakBgLaunch.swift'));
    expect(launch).not.toMatch(/dueAtStart|"drained"|wakeEngine|NotificationCenter/);
  });
});

describe('Task 8: the native background triggers reach the ONE engine wake', () => {
  // Phase 7 Task 3 added backgroundWake to the engine interface and the
  // TurboModule spec; Task 8 wired the native triggers to it. The wake is ONE
  // Rust call, Engine::background_wake, reached from JS (InProcessEngine),
  // from the iOS BGTask handler, and from the Android worker and service.
  it('is on the engine interface and the native FFI spec', () => {
    expect(read(repo + 'packages/core/src/engine/types.ts')).toMatch(/backgroundWake/);
    expect(read(repo + 'packages/core/src/NativeDaak.ts')).toMatch(/backgroundWake/);
  });

  it('is called by the iOS BGTask handler through one shared slot', () => {
    const launch = stripComments(read(repo + 'apps/mobile/ios/Daak/DaakBgLaunch.swift'));
    expect(launch).toMatch(/DaakBridge\.backgroundWake\?\(\)/);
  });

  it('is called by the Android worker and the foreground service', () => {
    const binvoke = /DaakWake\.wake\?\.invoke\(\)/;
    expect(stripComments(read(ktDir + 'DaakDrainWorker.kt'))).toMatch(binvoke);
    expect(stripComments(read(ktDir + 'DaakSyncService.kt'))).toMatch(binvoke);
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
    const screen = stripComments(read(repo + 'packages/ui/src/screens/SettingsScreen.tsx'));
    // REWRITTEN, not loosened: `BackgroundSyncNotice` appeared in this file
    // ONLY in a comment explaining the injection. The code renders the
    // `background` slot, so that is what is pinned. Slot injection, not an
    // import, is what keeps @daak/ui from depending on @daak/platform.
    expect(screen).toMatch(/\{background\}/);
    expect(screen).not.toMatch(/BackgroundSyncNotice/);
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
