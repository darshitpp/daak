import React from 'react';
import { AppRegistry } from 'react-native';
import { createUiRuntime } from '@daak/ui';
import { DaakPopoverShell, DaakDashboardShell } from './src/shells';
import { currentStartFault, reportStartFault } from './src/start-fault';
// Deep import, NOT the @daak/platform barrel, for the same reason
// src/shells.tsx:1-8 and src/window-host.ts:1-3 already record. That barrel
// re-exports bgsched/clipboard/fspaths/qr/securestore/share, each of which runs
// TurboModuleRegistry.getEnforcing('<name>') at module-eval time, and macOS
// registers only 'Daak', 'DaakSystemShare', 'DaakSystemNotify' and the desktop
// window/tray modules. Importing the barrel would throw before the first
// render. src/engine.ts is the only platform export this app reaches, and it
// touches exactly one native module: 'Daak', which Daak.swift does register.
import { createEngine } from '@daak/platform/src/engine';
// Deep imports again, and for the same reason as above: @daak/platform's
// barrel re-exports qr/securestore/notify/bgsched/share, each of which resolves
// a TurboModule at module-eval time that the macOS host does not register. The
// keystore is the only platform capability onboarding needs, and readOnboarding/
// writeOnboarding reach it through securestore, which is pure JS over
// NativeDaakSecureStore -- a module the desktop host DOES register
// (modules/rn-securestore/DaakSecureStore.podspec).
import { readOnboarding, writeOnboarding } from '@daak/platform/src/onboarding';
import {
  completeFirstRun,
  loadOnboardingGate,
  needsWindowFor,
  once,
  runGateThenPublish,
} from './src/onboarding';
import { publishOnboardingDecision, registerOnboardingCompleter } from './src/onboarding-store';
import { onDirectShareUrl } from './src/direct-share';
import { attachNotifyEngine, attachNotifyHost, onDesktopNotify } from './src/notify';
import { relocateInboxFiles } from './src/relocate';
import { attachPicker, nativeDesktopPickFiles } from './src/picker';
import { openDashboard } from './src/window-host';

// One engine for the whole process; popover and dashboard share the same engine
// and event stream.
//
// IN-PROCESS, not an IPC client of daakd (D16.10.3). This is the same
// createEngine() @daak/platform builds for mobile, so the two apps cannot drift
// in how they reach the engine. The daemon shape is what this used to be and it
// did not work here: DaemonClientEngine.connect() imports node:net and node:os,
// react-native-macos shims neither, and Metro refused to BUILD the bundle.
// createDesktopEngine and daakSocketPath survive as exported, tested helpers in
// src/engine.ts for the daemon shape Phase 8 may restore, and
// test/macos-inprocess-ffi.spec.ts pins that the running app never reaches them.
//
// createEngine() is SYNCHRONOUS (it wraps the Daak TurboModule), so there is no
// .then() and no connect() rejection to handle.
//
const engine = createEngine();

const runtime = createUiRuntime(engine);

/**
 * Publishes a decision to both windows, and brings the window FORWARD when the
 * decision needs it.
 *
 * needsWindow is not decoration. AppDelegate.mm orderOuts the window at launch
 * so nothing appears on its own. Every route back in -- the tray
 * menu, a daak:// link, a notification tap -- lives INSIDE the gate, so on a
 * FIRST launch there is no tray menu either. A returning user has an icon to
 * click and does not need a window forced on them; a first launch has no icon,
 * no window, and no other route in, so without this it would render a welcome
 * screen that nobody can ever see.
 *
 * openDashboard is the REAL host call, not a local no-op: window-host's
 * openDashboard resolves empty when DaakWindowHost is absent, which is
 * observably the same as not opening the window.
 *
 * needsWindowFor, NOT needsWindow, and the fault argument is the load-bearing
 * part: `ready` is published on the FAILED start path too (runGateThenPublish
 * does it on both outcomes so the gate has something to draw), so a returning
 * user whose engine will not bind publishes `ready` with a dead engine behind
 * it. needsWindow('ready') is false -- no window opened -- and the
 * gate's fault view renders into an orderOut window nobody can ever see. A
 * recorded start fault therefore brings the window forward; see needsWindowFor.
 */
function publishDesktopDecision(
  /** @type {import('./src/onboarding').OnboardingDecision} */ decision,
) {
  publishOnboardingDecision(decision);
  if (needsWindowFor(decision, currentStartFault())) void openDashboard();
}

/**
 * THE ONLY engine.start() IN THIS APP, behind a one-shot claim.
 *
 * startEngineOnce is reachable from TWO callers -- the returning-user gate
 * below and the first-run completer above it -- and engine.start() is not
 * idempotent: Daak.swift builds a NEW DaakEngine.newWithStore and calls
 * e.start() on it every time, so a second call is a second engine over the
 * same data dir, not a no-op. A launch whose keystore read resolved `ready`
 * while the flow also completed would otherwise bind twice.
 *
 * The claim lives on the START work itself rather than as a flag tested in
 * startEngineOnce, because startEngineOnce does real work AROUND the start
 * (publishing, priming): a caller that won the race must be the one that
 * publishes `ready`, and a loser must not.
 */
const claimEngineStart = once(async () => {
  try {
    await engine.start();
  } catch (error) {
    console.warn('daak: engine start failed:', error);
    reportStartFault(error);
    throw error;
  }
});

/**
 * Starts the engine, applies `displayName` when one is given, then primes. Once
 * per launch.
 *
 * runGateThenPublish RESOLVES false on a failure rather than rejecting (see
 * src/onboarding.ts), so the fault is reported from here instead of from a
 * catch that would never run.
 *
 * It publishes `ready` itself, and it does so AFTER the await settles -- see
 * runGateThenPublish's header. Both callers go through here, so neither can
 * mount the shell against an unstarted engine.
 */
function startEngineOnce(/** @type {string | undefined} */ displayName) {
  return runGateThenPublish(
    // The name property is OMITTED rather than set to undefined when there is
    // no name, because runOnboardingGate tests for the property's presence.
    displayName === undefined ? { kind: 'ready' } : { kind: 'ready', displayName },
    {
      // claimEngineStart, NOT a bare engine.start(): this is the same guarded
      // slot the first-run completer starts through, so the two paths can never
      // both bind. It performs the start and is the ONE place in this app that
      // does -- a second engine.start() spelled out here would be a second bind
      // waiting for the two paths to line up.
      //
      // The fault is reported inside the claim, where the engine's own words
      // are still in scope: runOnboardingGate deliberately swallows the
      // rejection so it cannot reject, which means a generic "could not start"
      // is the one thing this note cannot afford to be.
      start: async () => {
      // Awaited, and the boolean CHECKED on purpose. claimEngineStart resolves
      // TRUE for the caller that ran the start and FALSE for one that lost the
      // race. Discarding the false was a shipping defect a reviewer reproduced:
      // a losing caller then fell through to the same prime/publish path as if
      // an engine had come up behind it. Whether the engine is really up is not
      // something this caller can know -- the winner may have FAILED, and
      // once() deliberately keeps the slot consumed after a failure -- so a
      // loss is a failure here, not a pass-through.
      const won = await claimEngineStart();
      if (!won) throw new Error('engine start already attempted on this launch');
      },
      applyName: (name) => engine.setDisplayName(name),
      prime: () => runtime.prime(),
    },
    publishDesktopDecision,
  );
}

/**
 * A FIRST launch finishing the flow: write the durable state, and only then
 * start.
 *
 * The order is the point, and it is the reverse of the old module-scope
 * start(). Publishing a name needs a started engine, but a name that cannot be
 * remembered must not be published -- so the write is awaited first, and a
 * failed write reports instead of starting. Otherwise a Mac whose keychain is
 * read-only would show the flow, let the user type a name, and then re-ask them
 * on every launch, having told them nothing was saved.
 *
 * `alerts` is recorded but not asked here: on macOS the banner permission
 * belongs to the OS, and the row reports whatever the host actually knows
 * (desktopPermissionRows). Writing `false` here is the honest default -- Daak
 * has not established that the OS will let it post.
 */
registerOnboardingCompleter(async (result) => {
  // ONE chain, and it is deliberately a single chain rather than two callers
  // racing: write, then start, then publish, in that order, exactly once.
  //
  // completeFirstRun owns the first two steps and knows whether each landed --
  // it reports a refused OR rejected write (DaakSecureStore.set answers both
  // ways: true/false is the Swift result, E_KEYCHAIN is the throw), and it
  // reports a failed start separately so the user is not told their answers
  // were lost when they were saved.
  //
  // Publishing `ready` is deliberately NOT inside completeFirstRun: that would
  // put the store swap in two files, and it is the step that must happen after
  // the engine is up. Here it is on the success path only -- a refused write
  // must leave the flow on screen with its note, not swap it for the dashboard.
  const outcome = await completeFirstRun(
    result,
    { write: writeOnboarding },
    {
      // The SAME guarded slot startEngineOnce uses. Two different start sites
      // would be two binds of one data dir (see claimEngineStart). And the
      // same CHECK: on the "Look around first" path there is no applyName() to
      // catch a dead engine, so without the explicit throw a lost claim primed
      // a runtime that had nothing behind it and the app reported success.
      start: async () => {
        const won = await claimEngineStart();
        if (!won) throw new Error('engine start already attempted on this launch');
      },
      applyName: (name) => engine.setDisplayName(name),
      prime: () => runtime.prime(),
    },
  );
  if (!outcome.ok) return outcome;
  // The write landed AND the engine is up, so `ready` is finally true. The
  // dashboard mounts against a running engine rather than an empty Devices tab,
  // and needsWindow keeps the window forward -- the user is already looking at
  // this one.
  publishDesktopDecision({ kind: 'ready', displayName: result.name });
  return outcome;
});

// daak://send?deviceId=... routing. Registered HERE, above both roots, because
// the dashboard window is created at launch and merely orderOut: a link that
// arrives has to be able to reach a tree that is already mounted.
onDirectShareUrl();

// Desktop banners for a received payload, and the ONE action button on them.
// 'open' is the only INSTALLED action; 'share' and 'show' are in the frozen
// vocabulary and deliberately withheld (R37, see
// modules/rn-notify/js/actions.ts) because neither has an implementation, and
// a button that only foregrounds the app is worse than no button.
//
// Registered HERE for the same reason as onDirectShareUrl(): above both roots,
// and on the ONE engine stream, because that stream also carries pairing and
// transfer events that the dashboard is already reading.
//
// The engine and the window host are INJECTED rather than imported inside
// src/notify.ts, because that module is loaded by vitest under a react-native
// stub with no bridge, and it resolves the DaakSystemNotify TurboModule lazily
// inside onDesktopNotify. Injection is what lets test/notify.spec.ts drive the
// decision and the subscription without touching a native module.
attachNotifyEngine(engine);
attachNotifyHost(openDashboard);
onDesktopNotify();
// R42p: the download folder. Attached here, with the other one-time wiring.
relocateInboxFiles(engine);

// The composer's file picker (NSOpenPanel in RNShare.mm). Attached HERE, above
// both roots, for the same reason as onDirectShareUrl(): the dashboard window is
// created at launch, so a picker attached after registration would race the
// first render.
attachPicker(nativeDesktopPickFiles);

// FIRST-RUN ORDERING, and this is the whole reason this block is not the
// one-liner it used to be.
//
// It used to be `engine.start()` at module scope: EVERY launch started the
// engine, so a first launch published a machine-generated name before the
// user had been asked anything, and then asked them anyway. Asking for a name
// needs to know it has not been asked before, which is a keystore read, and
// publishing a name needs a started engine. So the read comes first, and
// nothing starts until the durable state permits it:
//
//   - complete: start once, exactly as before. No screens.
//   - not complete: the shells render the prototype's welcome flow, and the
//     engine starts only after the user finishes it (see OnboardingShell).
//   - the keystore REJECTS: start nothing and say so. Reading a locked
//     keychain as "not onboarded" would overwrite a real user's chosen name
//     with first-launch defaults, then publish it. src/onboarding.ts explains
//     why readOnboarding propagates instead of defaulting.
//
// And 'ready' is published only once the engine is actually up. Both paths --
// this one and the completion callback above -- reach the shells through
// startEngineOnce, which orders it that way.
//
// Registration deliberately stays OUTSIDE this promise (see below): a start
// rejection must still leave a window on screen, and that window is also where
// onboarding is drawn.
void loadOnboardingGate(readOnboarding).then(
  (decision) => {
    // Only a RETURNING user starts here. A first launch starts later, from the
    // completion callback, and a fault starts never. A NON-ready decision is
    // published straight through, which is what puts the flow -- or the fault
    // note -- on screen. A 'ready' one is NOT published here: it goes through
    // startEngineOnce, which starts the engine FIRST and publishes
    // afterwards, so a returning user's shell is never mounted against an
    // engine that has not come up yet.
    if (decision.kind !== 'ready') {
      publishDesktopDecision(decision);
      return;
    }
    // No .catch: startEngineOnce never rejects -- it reports the fault itself,
    // where the engine's own message is still in scope.
    // NO NAME IS PASSED. The engine reads its own display name from SQLite at
    // start, so a returning launch has nothing to apply. Replaying the
    // keystore copy here is what made a rename in Settings revert on every
    // relaunch. See src/onboarding.ts, loadOnboardingGate.
    void startEngineOnce();
  },
  // loadOnboardingGate does not reject (it returns a fault decision), so this
  // is belt-and-braces for a readOnboarding that rejects synchronously.
  (error) => {
    publishDesktopDecision({
      kind: 'fault',
      message: error instanceof Error ? error.message : String(error),
    });
  },
);

// Registration does NOT sit inside the .then(), unlike the daemon shape this
// replaced. There is no connection to fail here, so deferring registration
// would only mean a start() rejection left the process with no window and no
// diagnostic. Registering unconditionally and letting start() report its own
// failure keeps the honest state visible: the shells render against an engine
// that is not up, which is exactly what they would show with no daemon.
//
// The native moduleName is 'DaakDashboard' (AppDelegate.mm), which IS the
// second key registered below, so the shell and the dashboard now agree.
AppRegistry.registerComponent('DaakPopover', () =>
  function DaakPopoverRoot() {
    return <DaakPopoverShell engine={engine} runtime={runtime} />;
  });

AppRegistry.registerComponent('DaakDashboard', () =>
  function DaakDashboardRoot() {
    return <DaakDashboardShell engine={engine} runtime={runtime} />;
  });
