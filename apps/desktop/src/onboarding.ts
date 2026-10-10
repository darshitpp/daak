/**
 * Desktop first-run ordering, as a plain function of INJECTED collaborators.
 *
 * The prototype's desktop welcome screen is a real step, not decoration, and
 * it sits in front of something that must not happen early: the engine. This
 * module exists so that ordering rule is a thing that can be READ and TESTED
 * without a React tree, a native module, or a keystore.
 *
 * WHY IT IS NOT A COMPONENT (apps/desktop/index.js used to just call
 * engine.start() at module scope):
 *
 *  - ORDER IS THE WHOLE POINT. Publishing a display name needs a STARTED
 *    engine; asking for the name needs to know it has not been asked before,
 *    which is a keystore read. So: read first, ask second, start third. A
 *    component that started the engine on mount put the second step behind the
 *    first, and no amount of styling fixed it.
 *
 *  - A REJECTED READ MUST NOT START ANYTHING. readOnboarding deliberately
 *    propagates a keystore failure instead of reporting "not onboarded". If a
 *    locked keychain were read as a first launch, Daak would overwrite a real
 *    user's state with first-launch defaults -- and then publish a machine name
 *    over the name they chose. So the rejection ends the flow and the caller
 *    shows the failure.
 *
 * Every collaborator is injected, and `loadOnboardingGate` is pure: give it a
 * reader and it tells you what should happen, without performing anything. The
 * side effects live in `runOnboardingGate`, so the decision is checkable
 * without a running engine.
 */

/** What the durable state says, and what the caller should do about it. */
export type OnboardingDecision =
  /** Onboarded already. Start the engine and prime, with no screens shown. */
  | { kind: 'ready' }
  /** A first run just finished. Start, then publish the name the user typed. */
  | { kind: 'ready'; displayName: string }
  /** First launch. The caller shows the flow and calls back once it completes. */
  | { kind: 'onboard' }
  /** The keystore refused the read. Nothing may be started or written. */
  | { kind: 'fault'; message: string };

export interface OnboardingStateLike {
  complete: boolean;
  name?: string;
}

/**
 * The FIRST-RUN completion path, with the keystore and the engine injected.
 *
 * This is the whole of "answer three screens, then become a running app" as
 * one function, because that is the thing a user does and the thing whose
 * ORDER matters. index.js holds the real collaborators; it cannot be imported
 * from a test (createEngine + AppRegistry.run at module scope), so the rule
 * lives here where it can be executed without a native bridge.
 */

/** The answers the desktop flow collects. Mirrors CompletedOnboarding. */
export interface FirstRunAnswers {
  name?: string;
  alerts: boolean;
}

/** The exact OnboardingState shape packages/platform writes. */
export interface DurableOnboardingState {
  complete: boolean;
  name?: string;
  discovery: boolean;
  alerts: boolean;
}

export interface FirstRunWrite {
  /** writeOnboarding. Resolves false on a refused write, REJECTS on a throw. */
  write: (state: DurableOnboardingState) => Promise<boolean>;
}

export interface FirstRunOutcome {
  ok: boolean;
  /**
   * May the user press Continue again on THIS launch?
   *
   * Two different events land here and they are not interchangeable:
   *
   *  - A WRITE failure (refused false, or a rejected throw) is retryable. The
   *    answers never landed, nothing was started, and index.js's one-shot start
   *    claim was never consumed -- so a second press is a genuine first attempt.
   *    Keeping the gate's guard closed here is what made every save failure
   *    terminal: pressable buttons that do nothing, with no explanation.
   *
   *  - An ENGINE START failure is NOT retryable. The answers DID land, and
   *    claimEngineStart deliberately keeps a failed start consumed -- a
   *    half-bound data dir must not be bound twice -- so a released guard would
   *    send the retry into an already-consumed claim and report success over a
   *    dead engine (that is D1, end to end). The way through is a relaunch.
   *
   * So the field is REQUIRED rather than optional: a caller cannot report a
   * failure without saying which kind it is, which is precisely the ambiguity
   * that made the guard unconditionally closed.
   */
  retryable: boolean;
  message?: string;
}

export function describeReadFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The decision, WITHOUT performing it.
 *
 * Separated from the effects on purpose: the one property worth pinning is
 * "a first launch starts nothing", and that is only observable if the reading
 * of the durable state and the starting of the engine are different steps.
 */
export async function loadOnboardingGate(
  read: () => Promise<OnboardingStateLike>,
): Promise<OnboardingDecision> {
  let stored: OnboardingStateLike;
  try {
    stored = await read();
  } catch (error) {
    // Not "onboard". See the header: treating this as a fresh install would
    // re-run onboarding over a real user's state and then overwrite it.
    return { kind: 'fault', message: describeReadFailure(error) };
  }
  if (!stored.complete) return { kind: 'onboard' };
  // NO NAME IS CARRIED FORWARD. This is the second copy of the display name,
  // and the keystore is not the source of truth -- SQLite is (see AGENTS.md).
  // The engine reads its own name back at start, so replaying the onboarding
  // copy here would overwrite whatever the user last typed in Settings, on
  // every relaunch. That is the defect this returns nothing for.
  return { kind: 'ready' };
}

export interface OnboardingRunDeps {
  /** Starts the engine. Called at most once per run, and never on a fault. */
  start: () => Promise<void>;
  /** Applies the remembered name. Only ever called after start resolves. */
  applyName?: (name: string) => Promise<void>;
  /**
   * runtime.prime(), strictly after start. SYNCHRONOUS, and that is the real
   * signature (packages/ui/src/headless.ts:9) -- it kicks off the first device
   * fetch rather than awaiting it, so there is no promise here to await and
   * pretending otherwise would put a needless microtask between start() and the
   * first render.
   */
  prime?: () => void;
}

/**
 * start() -> applyName() -> prime(), in that order, exactly once.
 *
 * prime() is LAST because it asks the engine for the first device list: doing
 * it while start() is still in flight makes start() throw on a devices() it
 * cannot answer, which is the failure every mode in packages/ui/src/headless
 * surfaces as a dead shell. Applying the name before prime() is what makes the
 * first render show the name the user chose rather than the machine default.
 *
 * An `onboard` decision is NOT permission to start. It is the absence of a
 * decision: the user has not answered anything yet, so there is nothing to
 * publish a name from and no consent to begin discovery. Only `ready` starts.
 * (Returning true for it would let the one caller that runs this gate eagerly
 * start the engine on a first launch -- precisely the bug the read-first
 * ordering exists to prevent.) A first launch starts later, from the
 * completion callback, which passes a `ready` decision carrying the name the
 * user just typed.
 *
 * applyName() runs ONLY when the decision CARRIES a name, which is only the
 * first-run completion path. A returning launch gets a bare `{kind:'ready'}`
 * and starts, primes, and stops -- it must not replay a name, because the
 * engine already read the real one from SQLite at start.
 *
 * NEVER REJECTS. A failed start resolves false instead, so a caller cannot
 * both report the fault on screen and forget to handle the rejection -- two
 * different fates for one event, which is how a start failure ends up as an
 * unhandled rejection with nothing on screen.
 */
export async function runOnboardingGate(
  decision: OnboardingDecision,
  deps: OnboardingRunDeps,
): Promise<boolean> {
  if (decision.kind !== 'ready') return false;
  try {
    await deps.start();
    if ('displayName' in decision) {
      await deps.applyName?.(decision.displayName);
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    deps.prime?.();
  } catch {
    // The caller shows its own fault note; the engine's words are already in
    // the rejection it wrapped. Swallowing here keeps the one promise
    // well-behaved: resolve(false), never reject.
    return false;
  }
  return true;
}

export type DesktopOnboardingPhase = 'loading' | 'onboarding' | 'ready' | 'fault';

/**
 * What a window should DRAW, which is NOT the phase.
 *
 * 'ready' and 'shell' are different answers, and conflating them is how a
 * dashboard ends up mounted against an engine that never started: both trees
 * read `ready` and both render <DaakUiApp/>, and DaakUiApp asks the engine for
 * a device list on its first render. A dead engine answers that with an empty
 * list and no error -- a Devices tab that says "nothing nearby" and looks
 * perfectly healthy, which is exactly what src/shells.tsx exists to prevent.
 *
 * So there is a fifth answer. `faulted` draws the engine's own words and
 * nothing else: the window is still open (see needsWindow) and still shows why
 * the app is dead, but no live shell is mounted on top of it.
 *
 * WHY A PURE FUNCTION AND NOT A COMPONENT: the whole point of src/onboarding.ts
 * is that these rules can be executed without React, a native bridge, or a
 * keystore. This decision is the last such rule, and it is the one a reviewer
 * found shipped wrong -- so it gets a table test of its own rather than a
 * source grep for a component name.
 */
export type DesktopShellView = 'nothing' | 'flow' | 'shell' | 'faulted';

export function shellViewFor(
  phase: DesktopOnboardingPhase,
  startFault: string | null,
): DesktopShellView {
  // The keystore read failed. Nothing started and nothing was written, so there
  // is no engine fault to show either -- this is the read fault alone.
  if (phase === 'loading') return 'nothing';
  if (phase === 'fault') return 'faulted';
  if (phase === 'onboarding') return 'flow';
  // READY BUT DEAD. `ready` only ever means "the engine was told to come up";
  // startFault is the evidence that it did not. Rendering the shell here is the
  // defect this branch exists for.
  return startFault === null ? 'shell' : 'faulted';
}

/**
 * Start FIRST, publish SECOND.
 *
 * `publishOnboardingDecision({kind:'ready'})` is what swaps both windows from
 * the gate to `DaakUiApp`, and `DaakUiApp` asks the engine for a device list on
 * its first render. So publishing `ready` before start() resolves mounts the
 * live shell against an engine that is not up: an empty Devices tab, and -- on
 * the popover, which is only ever opened by a human -- no indication why.
 * index.js used to do exactly that on both paths.
 *
 * Why the failure path still PUBLISHES rather than staying in `loading`:
 * `loading` renders null (see phaseFor and the gate's comment), so swallowing a
 * failed start here would leave a blank window with no note on it. Publishing
 * `ready` on a failure is therefore CORRECT as a store update -- the gate's
 * job is over and the engine has already been recorded as dead by
 * reportStartFault. It is the DRAWING that has to differ, and that is
 * shellViewFor's rule: `ready` plus a fault renders the fault, never the shell.
 * Publishing ready is not a claim that an engine came up; it is a claim that
 * the launch has finished deciding.
 *
 * A non-ready decision publishes unchanged and starts nothing, so callers do
 * not have to re-derive that branch.
 */
export async function runGateThenPublish(
  decision: OnboardingDecision,
  deps: OnboardingRunDeps,
  publish: (decision: OnboardingDecision) => void,
): Promise<boolean> {
  if (decision.kind !== 'ready') {
    publish(decision);
    return false;
  }
  const started = await runOnboardingGate(decision, deps);
  // AFTER the await settles, on both outcomes. Never before it.
  publish(decision);
  return started;
}

/**
 * WRITE FIRST, THEN START. The completion half of the ordering rule.
 *
 * runOnboardingGate above starts and PUBLISHES; this one must also REMEMBER,
 * because a name the app cannot remember is a name it must not publish. So the
 * order here is the reverse of the runGateThenPublish order on purpose:
 *
 *   write -> (refused? stop) -> start -> applyName -> prime
 *
 * Why write before start, when starting is what makes publishing possible:
 * if the engine starts first and the write then fails, the user is told
 * nothing, the machine default name goes out to every peer, and the next
 * launch asks the same three questions again -- having promised each time
 * that this time was saved. That is worse than not starting at all, because a
 * failed write is REPORTABLE and a name nobody can be told is not.
 *
 * A refused write (false) and a rejected write (throw) are the same event with
 * different plumbing -- DaakSecureStore.set resolves true/false on the Swift
 * answer and REJECTS with E_KEYCHAIN on a status it cannot turn into one -- so
 * both land in one catch and both mean: do not start, do not claim success.
 *
 * The engine's own words survive into the message. "Could not save" with no
 * reason is a note the user can do nothing with.
 */
export async function completeFirstRun(
  answers: FirstRunAnswers,
  store: FirstRunWrite,
  deps: OnboardingRunDeps,
): Promise<FirstRunOutcome> {
  let written: boolean;
  try {
    written = await store.write({
      complete: true,
      // The name is carried ONLY when there is one. "Look around first" is a
      // real exit, and publishing an empty string on it would rename the Mac to
      // nothing on the next launch.
      name: answers.name,
      // A FACT of engine.start(), not a grant the user made: DaakEngine has no
      // stopDiscovery, so there is nothing to switch off and nothing truthful
      // to record as declined.
      discovery: true,
      alerts: answers.alerts,
    });
  } catch (error) {
    return {
      ok: false,
      // The write never landed, so nothing is durable and nothing was started:
      // claimEngineStart is untouched and a second press is a real first
      // attempt. The user is not stuck and must not be told to relaunch.
      retryable: true,
      message:
        'This Mac would not save your choices (' + describeReadFailure(error) +
        '), so Daak would ask again every launch.',
    };
  }
  if (!written) {
    return {
      ok: false,
      retryable: true,
      message: 'This Mac would not save your choices, so Daak would ask again every launch.',
    };
  }

  // The write LANDED, so the answers are durable and the next launch will not
  // ask again. What can still fail is the engine, and that is a DIFFERENT
  // event: reporting it as an unsaved choice would send the user back through
  // three screens on a machine that already recorded every answer. So the two
  // failures are kept distinguishable, and neither is reported as success.
  // The name is carried ONLY when there is one. "Look around first" is a real
  // exit, and a decision with `displayName: undefined` would still pass an
  // `in` check -- so the property is OMITTED rather than set, which keeps the
  // skip path on the same no-name branch as a returning launch.
  const decision: OnboardingDecision =
    answers.name === undefined
      ? { kind: 'ready' }
      : { kind: 'ready', displayName: answers.name };
  // runOnboardingGate deliberately swallows the start rejection (so it can
  // never reject) and with it the engine's message. That is right for its own
  // caller, which reports through a fault note, but here the note is the ONLY
  // thing the user is told -- so the message is captured on the way past, at
  // the one place the rejection is still in scope, and re-thrown so the gate
  // sees exactly the failure it would have seen anyway.
  let startFailure = '';
  const started = await runOnboardingGate(decision, {
    ...deps,
    start: async () => {
      try {
        await deps.start();
      } catch (error) {
        startFailure = describeReadFailure(error);
        throw error;
      }
    },
  });
  if (!started) {
    return {
      ok: false,
      // TERMINAL FOR THIS LAUNCH. The write landed, so there is nothing left to
      // save; what failed is the engine, and index.js's claimEngineStart is
      // deliberately still consumed. Releasing the gate's guard here would send
      // the retry into a claim that returns false, prime() against a dead
      // engine, and {ok:true} -- see runOnboardingGate's header on D1.
      retryable: false,
      message:
        'Your choices were saved, but Daak\'s engine did not start on this Mac. ' +
        (startFailure === '' ? '' : 'What it said: ' + startFailure + ' ') +
        'Relaunch Daak to try again.',
    };
  }
  // Nothing failed, so there is nothing to retry.
  return { ok: true, retryable: false };
}

export function phaseFor(decision: OnboardingDecision | undefined): DesktopOnboardingPhase {
  if (decision === undefined) return 'loading';
  if (decision.kind === 'fault') return 'fault';
  if (decision.kind === 'onboard') return 'onboarding';
  return 'ready';
}

/**
 * Must this decision bring a window FORWARD, unprompted?
 *
 * AppDelegate.mm does [self.window orderOut:nil] at launch, so the window
 * exists but nothing shows it. The menu-bar status item is the quick-share
 * surface. Every route back in -- the tray menu, a daak:// link, a
 * notification tap -- is inside the gate, so on a FIRST launch there is no
 * tray menu yet. Onboarded users open their own dashboard from the status
 * item or the Dock icon. A first launch, and a fault, have no ready surface,
 * so nothing would ever put a window on screen and the user would be stuck in
 * front of an app with no visible surface at all.
 *
 * So: onboard and fault bring the window forward, `ready` does not (it is
 * published only after a successful start, and a returning launch must not pop
 * a window open on every start), and no decision yet means the launch has not
 * reached its end.
 */
export function needsWindow(decision: OnboardingDecision | undefined): boolean {
  return decision !== undefined && decision.kind !== 'ready';
}

/**
 * needsWindow, AND the one case it cannot see on its own.
 *
 * `ready` alone says nothing about whether an engine came up. runGateThenPublish
 * publishes `ready` on the FAILURE path too -- deliberately, so the window has a
 * fault note to draw rather than rendering blank (see its header) -- and
 * startEngineOnce is the only caller that can therefore end a launch having
 * published `ready` with a dead engine behind it.
 *
 * That is invisible on a menu-bar app: needsWindow({kind:'ready'}) is false, so
 * nothing calls openDashboard(), AppDelegate.mm's orderOut stands, there is no
 * Dock icon, and the gate's fault view renders into a window the user cannot
 * see. The fault is recorded, published, drawn -- and never seen. A returning
 * user whose engine will not bind gets a silent no-op, which is the one outcome
 * worse than an ugly window.
 *
 * So the caller passes the fault in. A recorded start fault means the window is
 * the ONLY surface that can explain the failure, so it comes forward. This is
 * the same rule needsWindow already states for `fault` and `onboard`, extended
 * to the one decision whose name does not admit it.
 *
 * needsWindow above is UNCHANGED and still exported, because the decision-only
 * rule is the correct answer for everything that has not started an engine yet,
 * and index.js's non-ready publish path (the keystore read fault) has no start
 * fault to consider.
 */
export function needsWindowFor(
  decision: OnboardingDecision | undefined,
  startFault: string | null,
): boolean {
  // The fault is the whole question here: it can only have been recorded by
  // reportStartFault, which only claimEngineStart calls, and only after a start
  // that threw. So a fault here means the engine is dead, whatever the decision
  // says.
  return startFault !== null || needsWindow(decision);
}

/**
 * Run `work` at most once, ever.
 *
 * WHY THIS IS NOT A BOOLEAN FLAG: engine.start() is reachable from TWO callers
 * -- the returning-user gate and the first-run completer -- and neither is the
 * only one. It is also not idempotent: Daak.swift builds a NEW
 * DaakEngine.newWithStore and calls e.start() on it every time, so a second
 * call is a second engine over the same data dir, not a no-op.
 *
 * The slot is claimed when the guard is CALLED, not after the work settles.
 * start() is async, so a claim that waited for the await would let a second
 * caller in while the first is still binding -- which is the whole window this
 * guard exists to close.
 *
 * A FAILED run keeps the slot. The engine is down for this launch either way,
 * and a retry against a data dir that is half-bound is worse than one honest
 * fault note the user can act on.
 *
 * A losing caller is told it lost: `false` for sync work, a promise resolving
 * false for async. It is never left hanging and never silently re-runs --
 * otherwise the caller publishes `ready` believing an engine came up behind a
 * start that never happened.
 */
export function once(work: () => void): () => boolean;
export function once(work: () => Promise<void>): () => Promise<boolean>;
export function once(work: () => void | Promise<void>): () => boolean | Promise<boolean> {
  let claimed = false;
  // Set by the WINNING call, which is by definition the first one -- a loser
  // can always be told what kind of answer it is getting. Probing
  // `work.constructor.name === 'AsyncFunction'` instead would be reading a name
  // that a minifier or a transpiler is free to change, and the failure mode is
  // a loser handed `false` where it awaited `false`.
  let async_ = false;
  return function claim(): boolean | Promise<boolean> {
    if (claimed) {
      // Resolve the loser rather than re-running. The distinction is invisible
      // to a boolean caller and deliberate for an async one.
      return async_ ? Promise.resolve(false) : false;
    }
    claimed = true;
    const result = work();
    if (result instanceof Promise) {
      async_ = true;
      // The rejection is passed through rather than swallowed: the caller
      // needs it to report the engine's own words. The slot is already claimed,
      // so the failure does not reopen it.
      return result.then(() => true);
    }
    return true;
  };
}

/** What the desktop host can report during onboarding. */
export interface DesktopCapability {
  /** Whether the OS will post an arrival banner, or undefined if never asked. */
  notifications?: boolean;
}

export interface DesktopPermissionRow {
  key: string;
  title: string;
  sub: string;
  /** 'unavailable' means reported, with nothing on this step able to change it. */
  state: 'on' | 'off' | 'unavailable';
}

/**
 * The one row of the Permissions step on a Mac (design: "Alerts when a file
 * arrives"). The state is 'unavailable', because the desktop host has no
 * `requestPermission` surface. The preference lives in Settings (plan P2). The
 * words equal `ALERTS_TITLE` and `ALERTS_SUB` in `@daak/platform`. This file
 * must not import that barrel (see `onboarding-flow.tsx`).
 */
export function desktopPermissionRows(): { rows: DesktopPermissionRow[] } {
  return {
    rows: [
      {
        key: 'alerts',
        title: 'Alerts when a file arrives',
        sub: 'A short banner so you know something came in.',
        state: 'unavailable',
      },
    ],
  };
}
