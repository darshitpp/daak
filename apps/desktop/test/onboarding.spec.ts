import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { stripComments } from './strip-comments';
import {
  completeFirstRun,
  desktopPermissionRows,
  loadOnboardingGate,
  needsWindow,
  needsWindowFor,
  once,
  phaseFor,
  runGateThenPublish,
  runOnboardingGate,
  shellViewFor,
  type OnboardingDecision,
} from '../src/onboarding';

/**
 * Desktop first-run ORDERING.
 *
 * apps/desktop/index.js used to call engine.start() at module scope, which
 * meant every launch started the engine before anything had been asked. These
 * pin the three properties that fix introduces and that no screenshot could
 * show: nothing starts before the durable state permits it, a keystore failure
 * starts nothing at all, and the remembered name is applied AFTER the start it
 * depends on.
 */
const complete = { complete: true, name: "Darshit's MacBook", discovery: true, alerts: true };
const fresh = { complete: false, discovery: false, alerts: false };

// stripComments lives in ./strip-comments, shared with the D1 pin below rather
// than copied into each file that needs it.
//
// KNOWN LIMITATION, deliberately left as-is: the scanner has NO regex-literal
// mode, so a `/.../` containing a quote or a `//` desyncs it. That is safe here
// and in index.js because no regex literal precedes any assertion made on a
// stripped body -- and a reviewer mutation-tested the D1 assertion below against
// a mis-parse, where it fails LOUDLY rather than passing for the wrong reason.

/** Records the order of every engine-touching call, which is the whole point. */
function tracer() {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      start: async () => {
        calls.push('start');
      },
      applyName: async (name: string) => {
        calls.push('setDisplayName:' + name);
      },
      prime: () => {
        calls.push('prime');
      },
    },
  };
}

/** Index of the `}` that closes the `{` at `open`, or -1 if it never closes. */
function matchBrace(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/**
 * The LARGEST brace-balanced `{...}` region at or after `from` that contains
 * `needle`.
 *
 * Why not a fixed slice to the next `\n}` or `\n});`: the two D1 closures end
 * differently, and a slice rule that matches only one of them would silently
 * read the OTHER closure's text -- so the assertion would pass with one check
 * in the file instead of two. Brace matching cannot mistake one for the other.
 *
 * Why largest rather than first: the claim sits inside a nested `deps` object
 * literal (`runGateThenPublish({...}, { start: async () => {...} }, ...)`), and
 * that inner `{` also balances and also contains the needle. Taking the outer
 * body is what makes the region a whole closure rather than one object.
 *
 * Comments are already stripped by the caller, so every brace counted here is
 * real code. test/picker.spec.ts walks the same file the same way.
 */
function regionContaining(source: string, needle: RegExp): string {
  let best = '';
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== '{') continue;
    const end = matchBrace(source, i);
    if (end === -1) continue;
    const span = source.slice(i, end + 1);
    if (span.search(needle) !== -1 && span.length > best.length) best = span;
  }
  return best;
}

describe('desktop onboarding gate', () => {
  it('sends a first launch to the flow instead of starting the engine', async () => {
    const { calls, deps } = tracer();
    const decision = await loadOnboardingGate(async () => fresh);
    expect(decision).toEqual({ kind: 'onboard' });
    // The decision itself started nothing: loadOnboardingGate is a pure read, so
    // asking the question cannot start the engine.
    expect(calls).toEqual([]);
    // And running the gate on it starts nothing either. `onboard` is the
    // ABSENCE of a decision, not permission: the user has answered nothing, so
    // there is no name to publish and no consent to begin discovery. Treating
    // it as permission is the exact bug the read-first ordering prevents.
    expect(await runOnboardingGate(decision, deps)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('starts once and primes once for a returning user, with no screens', async () => {
    const { calls, deps } = tracer();
    const decision = await loadOnboardingGate(async () => complete);
    expect(decision).toEqual({ kind: 'ready' });
    expect(await runOnboardingGate(decision, deps)).toBe(true);
    // NO setDisplayName on a returning launch. The engine reads its own name
    // from SQLite at start, and that file is the source of truth, so replaying
    // the KEYCHAIN copy over it would undo every rename made in Settings.
    expect(calls).toEqual(['start', 'prime']);
  });

  // The replay was the second copy. SQLite holds the name the user typed;
  // packages/platform/src/onboarding.ts holds the name typed during FIRST-RUN
  // onboarding, and that one is only ever right until the user renames. A
  // returning launch replaying it is how a Settings rename reverted on every
  // relaunch even after the database started working.
  //
  // This is why the decision carries NO name at all on the returning path, and
  // why first-run completion -- which is the ONE place a name genuinely must
  // be applied -- builds the name into its own decision instead (see the
  // completeFirstRun tests below).
  it('replays no name from the keystore on a returning launch', async () => {
    const { calls, deps } = tracer();
    const decision = await loadOnboardingGate(async () => complete);
    await runOnboardingGate(decision, deps);
    expect(calls.filter((c) => c.startsWith('setDisplayName'))).toEqual([]);
  });

  // The name can only be PUBLISHED by a started engine, so applying it first
  // would be a setDisplayName against an engine that is not up -- which is the
  // silent no-op that leaves every peer seeing the machine's default name.
  it('applies the display name only after the engine has started', async () => {
    const order: string[] = [];
    let started = false;
    await runOnboardingGate(
      { kind: 'ready', displayName: 'Studio' },
      {
        start: async () => {
          started = true;
          order.push('start');
        },
        applyName: async () => {
          order.push('setDisplayName');
          expect(started).toBe(true);
        },
      },
    );
    expect(order).toEqual(['start', 'setDisplayName']);
  });

  // A locked keychain must not read as a first launch. If it did, Daak would
  // show onboarding over a real user's state and then write first-launch
  // defaults -- replacing the name they chose with a machine-generated one.
  it('starts nothing when the keystore refuses the read', async () => {
    const { calls, deps } = tracer();
    const decision = await loadOnboardingGate(async () => {
      throw new Error('The user name or passphrase you entered is not correct.');
    });
    expect(decision).toEqual({
      kind: 'fault',
      message: 'The user name or passphrase you entered is not correct.',
    });
    expect(await runOnboardingGate(decision, deps)).toBe(false);
    expect(calls).toEqual([]);
  });

  // A user who ever skipped naming has no stored name, and start() must still
  // run -- there is simply nothing to apply.
  it('starts without applying a name when none was ever stored', async () => {
    const { calls, deps } = tracer();
    const decision = await loadOnboardingGate(async () => ({ complete: true, discovery: true, alerts: false }));
    await runOnboardingGate(decision, deps);
    expect(calls).toEqual(['start', 'prime']);
  });

  // A rejected start must not fall through to prime(): the runtime would fetch
  // a device list from an engine that is not up, which is the dead shell.
  it('does not prime when the start itself fails', async () => {
    const prime = vi.fn();
    const ok = await runOnboardingGate({ kind: 'ready' }, {
      start: async () => {
        throw new Error('bind failed');
      },
      prime,
    });
    expect(ok).toBe(false);
    expect(prime).not.toHaveBeenCalled();
  });
});

/**
 * FIRST LAUNCH, WHOLE PATH. The describes above test the gate, the rows and the
 * publish ORDER in isolation; none of them is the thing a user does, which is:
 * answer three screens, and get a started engine and a dashboard -- with the
 * durable write landed before anything the engine can do.
 *
 * completeFirstRun is that path with the keystore and the engine injected,
 * because index.js cannot be imported here (createEngine + AppRegistry at module
 * scope) and a source-order assertion cannot tell "the write happened" from
 * "the write was called".
 */
describe('a first launch that the user finishes', () => {
  const answers = { name: "Darshit's MacBook", alerts: false };

  /** One ledger of every side effect, in the order it happened. */
  function ledger() {
    const calls: string[] = [];
    return {
      calls,
      // The exact shape packages/platform's OnboardingState is, so a field
      // this test does not know about cannot hide here and break the write.
      write: async (state: {
        complete: boolean;
        name?: string;
        discovery: boolean;
        alerts: boolean;
      }) => {
        calls.push('write:' + JSON.stringify(state));
        return true;
      },
      deps: {
        start: async () => {
          calls.push('start');
        },
        applyName: async (name: string) => {
          calls.push('setDisplayName:' + name);
        },
        prime: () => {
          calls.push('prime');
        },
      },
    };
  }

  // The single ordering rule of the whole feature: a name the app cannot
  // remember is a name it must not publish. If the engine started first and the
  // write then failed, the user is told nothing, the name is a machine default
  // on every peer, and the next launch asks the same three questions again.
  it('writes the durable state BEFORE it starts the engine', async () => {
    const { calls, write, deps } = ledger();
    const outcome = await completeFirstRun(answers, { write }, deps);
    expect(outcome).toEqual({ ok: true, retryable: false });
    // The write, and then the whole rest of the path in order.
    expect(calls).toEqual([
      'write:{"complete":true,"name":"Darshit\'s MacBook","discovery":true,"alerts":false}',
      'start',
      'setDisplayName:Darshit\'s MacBook',
      'prime',
    ]);
  });

  // The failure the whole shape exists for: a keychain that will not take the
  // write. Starting anyway would show a dashboard whose name is forgotten, and
  // the flow would have reported success.
  it('starts nothing and reports the refusal when the write does not land', async () => {
    const { calls, deps } = ledger();
    const outcome = await completeFirstRun(answers, { write: async () => false }, deps);
    expect(outcome.ok).toBe(false);
    // RETRYABLE, and this is the load-bearing half of the assertion. Nothing
    // landed and nothing was started, so index.js's one-shot claim is untouched
    // and a second press is a genuine first attempt. Reporting a save failure
    // as terminal is what left Continue pressable and dead on every launch.
    expect(outcome.retryable).toBe(true);
    expect(outcome.message).toContain('every launch');
    // No start, no name published, nothing primed.
    expect(calls).toEqual([]);
  });

  // A write that REJECTS is the same failure with one more hop in it, and it is
  // the one the native module actually produces (DaakSecureStore rejects with
  // E_KEYCHAIN; a boolean false is the Swift success answer). An unhandled
  // rejection here would leave the gate on the permissions screen with no note
  // and no dashboard.
  it('reports a rejected write rather than leaving it unhandled', async () => {
    const { calls, deps } = ledger();
    const outcome = await completeFirstRun(
      answers,
      {
        write: async () => {
          throw new Error('keychain write failed: -25308');
        },
      },
      deps,
    );
    expect(outcome.ok).toBe(false);
    // Same event, one more hop in it, same answer: nothing was spent, so the
    // retry is safe. DaakSecureStore's E_KEYCHAIN rejection is the real shape
    // and this is the branch that would otherwise strand the user.
    expect(outcome.retryable).toBe(true);
    // The engine's own words survive into the message: "could not save" with no
    // reason is a note the user can do nothing about.
    expect(outcome.message).toContain('-25308');
    expect(calls).toEqual([]);
  });

  // "Look around first" is a real exit, and it exits the same way: it writes, it
  // starts, it primes -- with NO name, because the user never gave one. A path
  // that published an empty string here would rename the Mac to nothing on the
  // next launch.
  it('writes and starts on the skip path too, with no name at all', async () => {
    const { calls, write, deps } = ledger();
    await completeFirstRun({ alerts: false }, { write }, deps);
    expect(calls[0]).toBe('write:{"complete":true,"discovery":true,"alerts":false}');
    // No setDisplayName at all: the machine default the engine already has is
    // what the user accepted by skipping.
    expect(calls.some((c) => c.startsWith('setDisplayName'))).toBe(false);
    expect(calls).toContain('start');
    expect(calls).toContain('prime');
  });

  // The write LANDED, so the state is durable and the next launch will not ask
  // again. What failed is the engine. Reporting this as "not saved" would send
  // the user back through the same three screens on a machine that has already
  // recorded every answer -- the exact re-ask loop the write-first ordering was
  // built to prevent.
  //
  // So it reports the engine's failure, in the engine's own words, and it does
  // not claim the launch succeeded.
  it('reports a failed engine start as a failed start, not as a failed save', async () => {
    const { calls, write } = ledger();
    const outcome = await completeFirstRun(
      answers,
      { write },
      {
        start: async () => {
          throw new Error('address already in use');
        },
        prime: () => {
          calls.push('prime');
        },
      },
    );
    expect(outcome.ok).toBe(false);
    // TERMINAL, and the difference from the two write failures above is the
    // whole point of the flag. The answers DID land; what failed is the engine;
    // and claimEngineStart deliberately keeps a failed start consumed. A
    // released guard here would retry into a consumed claim and report
    // {ok:true} over a dead engine -- D1, end to end.
    expect(outcome.retryable).toBe(false);
    // NOT "every launch" -- that string means the answers were lost, which is
    // false here and would misdirect the user into re-typing their name.
    expect(outcome.message).not.toContain('every launch');
    expect(outcome.message).toContain('address already in use');
    // The write still happened, and nothing was primed against a dead engine.
    expect(calls[0]).toMatch(/^write:/);
    expect(calls).not.toContain('prime');
  });

  /**
   * D1, THE SHIPPING DEFECT, reproduced end to end.
   *
   * A first launch whose engine start FAILS: the write landed, so the gate
   * released its one-shot guard to let the user try again. But index.js's
   * claimEngineStart deliberately KEEPS a failed start consumed -- a half-bound
   * data dir must not be bound twice. So the retry reached an already-consumed
   * claim, got a bare `false` instead of a throw, and -- on the SKIP path there
   * is no applyName() whose setDisplayName would have thrown on the dead engine
   * -- nothing was left to catch it. prime() ran against an engine that never
   * came up and completeFirstRun returned {ok:true}: the app reported success
   * and mounted the dashboard over nothing.
   *
   * The fix is in index.js, where the claim's answer is checked, so this test
   * pins the SHAPE of that check: a lost claim must THROW, which is the only
   * thing runOnboardingGate can turn into a false. `await claimEngineStart()`
   * with the boolean discarded is exactly the defect, and the assertion below
   * fails against it.
   */
  it('fails honestly when the start claim was already spent, instead of reporting success', async () => {
    const { calls, write } = ledger();
    // The claim is already consumed by an earlier, failed attempt -- which is
    // the state the app is really in after the user retries.
    const claim = once(async () => {
      throw new Error('bind failed');
    });
    await expect(claim()).rejects.toThrow('bind failed');

    const outcome = await completeFirstRun({ alerts: false }, { write }, {
      // EXACTLY index.js's start closure after the fix.
      start: async () => {
        const won = await claim();
        if (!won) throw new Error('engine start already attempted on this launch');
      },
      prime: () => {
        calls.push('prime');
      },
    });

    // NOT ok. This is the whole assertion: the retry must not be told it
    // succeeded.
    expect(outcome.ok).toBe(false);
    // And nothing was primed against an engine that never existed.
    expect(calls).not.toContain('prime');
  });

  // The same on the NAMED path, where a lost claim used to be caught only by
  // accident: applyName reaches Swift, which throws notStarted. That is luck, not
  // design, and the skip path above is the one with no such accident.
  it('fails a spent claim even when a name would have been applied', async () => {
    const { calls, write } = ledger();
    const claim = once(async () => {
      throw new Error('bind failed');
    });
    await expect(claim()).rejects.toThrow('bind failed');
    const outcome = await completeFirstRun(answers, { write }, {
      start: async () => {
        const won = await claim();
        if (!won) throw new Error('engine start already attempted on this launch');
      },
      applyName: async (name: string) => {
        calls.push('setDisplayName:' + name);
      },
      prime: () => {
        calls.push('prime');
      },
    });
    expect(outcome.ok).toBe(false);
    // The name was never published to a dead engine either.
    expect(calls.some((c) => c.startsWith('setDisplayName'))).toBe(false);
  });
});

/**
 * THE WHOLE LAUNCH, keystore in and windows out.
 *
 * Every test above either stops at the gate, at the store, or at the window
 * host. None of them is a launch. This one runs the sequence the app actually
 * runs -- read, decide, act -- for all FOUR outcomes, and checks the thing that
 * only shows up when they are composed: which windows are brought forward, and
 * in what order the engine was touched.
 *
 * It is the composition that index.js performs, re-expressed with injected
 * collaborators, because index.js cannot be imported here (createEngine and
 * AppRegistry.run at module scope need the native bridge).
 */
describe('a whole launch, keystore in and windows out', () => {
  /** The app's launch: read, decide, act, and bring up a window if needed. */
  async function launch(stored: () => Promise<{
    complete: boolean;
    name?: string;
    discovery: boolean;
    alerts: boolean;
  }>) {
    const events: string[] = [];
    const publish = (d: OnboardingDecision) => {
      events.push('publish:' + d.kind);
      if (needsWindow(d)) events.push('openWindow');
    };
    const deps = {
      start: async () => {
        events.push('start');
      },
      applyName: async (name: string) => {
        events.push('setDisplayName:' + name);
      },
      prime: () => {
        events.push('prime');
      },
    };

    // index.js: a non-ready decision publishes straight through; a ready one
    // goes through startEngineOnce, which starts FIRST and publishes after.
    const decision = await loadOnboardingGate(stored);
    if (decision.kind !== 'ready') {
      publish(decision);
      return events;
    }
    await runGateThenPublish(decision, deps, publish);
    return events;
  }

  // The first launch a user actually has. It must be VISIBLE: this app has no
  // Dock icon and orderOuts its window at launch, so a published `onboard` with
  // no openWindow is a welcome screen nobody can ever see.
  it('brings a window forward on a first launch and starts nothing', async () => {
    expect(await launch(async () => fresh)).toEqual(['publish:onboard', 'openWindow']);
  });

  // The same for a locked keystore: the note says "relaunch Daak to try again",
  // which is advice the user can only follow if they can see it.
  it('brings a window forward for a keystore fault and starts nothing', async () => {
    const events = await launch(async () => {
      throw new Error('keychain locked');
    });
    expect(events).toEqual(['publish:fault', 'openWindow']);
  });

  // The SECOND launch, end to end: no screens, engine up, NO name replayed, and
  // no window forced on a returning user who has an icon to click. The engine
  // reads the real name from SQLite at start, so there is nothing to apply.
  it('starts and primes on a second launch without opening a window', async () => {
    expect(await launch(async () => complete)).toEqual([
      'start',
      'prime',
      'publish:ready',
    ]);
  });

  // And the second launch of a user who skipped naming: still starts, still
  // primes, and publishes no name at all rather than publishing an empty one.
  it('starts a nameless returning user without inventing a name', async () => {
    expect(await launch(async () => ({ complete: true, discovery: true, alerts: false }))).toEqual([
      'start',
      'prime',
      'publish:ready',
    ]);
  });
});

/**
 * BOTH PATHS START EXACTLY ONCE.
 *
 * The two ways to reach a start are the returning-user gate and the first-run
 * completer, and index.js holds both. engine.start() is not idempotent -- the
 * Swift half builds a NEW UniFFI engine and calls e.start() on it, so a second
 * call is a second bind of the same data dir -- so the guard is the only thing
 * standing between them and a doubled bind.
 */
describe('the engine is started at most once per launch', () => {
  // The subtle one: the slot is claimed when the guarded work is CALLED, not
  // after it settles. start() is async, so a claim that waited for the await
  // would let a second caller in while the first is still binding.
  //
  // CONCURRENT, and that is the whole point. This test used to await the first
  // call and only then make the second one, which passes just as happily
  // against an implementation that claims the slot AFTER the async work
  // settles -- which is precisely the bug the guard exists to prevent. A
  // reviewer rewrote once() that way and the whole suite stayed green. So the
  // first call is held IN FLIGHT here and the second arrives while it is
  // still running.
  it('claims the slot before the guarded work resolves', async () => {
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ran = 0;
    const claim = once(async () => {
      ran += 1;
      await inFlight;
    });

    // Both calls before EITHER settles. If the slot were claimed after the
    // await, `ran` would be 2 here.
    const first = claim();
    const second = claim();
    expect(ran).toBe(1);

    release();
    await expect(first).resolves.toBe(true);
    // The loser is told it lost, rather than being left hanging or re-running
    // the work -- otherwise it publishes ready believing an engine came up
    // behind a start that never happened.
    await expect(second).resolves.toBe(false);
    expect(ran).toBe(1);
  });

  // The same property for SYNCHRONOUS work, where there is no await to hide
  // behind: a second call in the same turn must be refused outright.
  it('refuses a second sync claim in the same turn', () => {
    let ran = 0;
    const claim = once(() => {
      ran += 1;
    });
    expect(claim()).toBe(true);
    expect(claim()).toBe(false);
    expect(ran).toBe(1);
  });

  // once()'s async half: the SECOND caller must learn it did not run, not hang
  // and not re-run. Otherwise the second caller publishes ready believing an
  // engine came up behind it. Both calls are awaited here, so this pins the
  // SEQUENTIAL case; the in-flight case above is a separate test because it is
  // the one an implementation that claims after the await would fail.
  it('tells a losing caller that it did not run, and resolves it false', async () => {
    const calls: string[] = [];
    const claim = once(async () => {
      calls.push('start');
    });
    await expect(claim()).resolves.toBe(true);
    await expect(claim()).resolves.toBe(false);
    expect(calls).toEqual(['start']);
  });

  // A start that FAILED still consumed the slot: the engine is down for this
  // launch either way, and a second attempt against a data dir that is
  // half-bound is worse than an honest fault note the user can act on.
  it('does not retry after a failed start', async () => {
    const calls: string[] = [];
    const claim = once(async () => {
      calls.push('start');
      throw new Error('bind failed');
    });
    await expect(claim()).rejects.toThrow('bind failed');
    await expect(claim()).resolves.toBe(false);
    expect(calls).toEqual(['start']);
  });

  // And the guard has to hold across BOTH callers, not just one -- two ready
  // decisions between them must produce one bind and still publish both, because
  // the SHELL needs telling to swap even when the start behind it was someone
  // else's.
  it('starts once when two ready decisions are both run through the gate', async () => {
    const calls: string[] = [];
    const claim = once(async () => {
      calls.push('start');
    });
    const published: string[] = [];
    const publish = (d: { kind: string }) => {
      published.push(d.kind);
    };
    await runGateThenPublish({ kind: 'ready' }, { start: async () => { await claim(); } }, publish);
    await runGateThenPublish({ kind: 'ready' }, { start: async () => { await claim(); } }, publish);
    expect(calls).toEqual(['start']);
    expect(published).toEqual(['ready', 'ready']);
  });
});

/**
 * THE ONE WINDOW THE USER CAN ACTUALLY SEE.
 *
 * AppDelegate.mm orderOuts the dashboard at launch and nothing orders it back
 * in until a human does something -- the tray, a daak:// link, a notification
 * tap. On a FIRST launch every one of those paths leads back to the same gate,
 * so the three onboarding screens would render into a window nobody ever
 * opened, on a menu-bar app with no Dock icon and no visible window.
 */
describe('which decisions need a window brought forward', () => {
  it('brings the window forward for every decision that ends the launch', () => {
    expect(needsWindow({ kind: 'onboard' })).toBe(true);
    // A fault is a TERMINAL decision too. Its note says "relaunch Daak to try
    // again", which is advice a user can only follow if they can SEE it -- and
    // the only window they would otherwise see is one nothing ever opened. So a
    // fault gets a window for the same reason onboarding does.
    expect(needsWindow({ kind: 'fault', message: 'locked' })).toBe(true);
    // 'ready' is the exception, and it is not a small one: it is published only
    // AFTER a successful start, and a returning user with a menu-bar icon can
    // open their own dashboard. Forcing a window up would make the app pop
    // open on every single launch, and a returning launch must not do that.
    expect(needsWindow({ kind: 'ready' })).toBe(false);
    // Nothing has been decided yet, and the launch is not over.
    expect(needsWindow(undefined)).toBe(false);
  });

  // The case needsWindow cannot see, and it is the one that left a start fault
  // invisible. `ready` is published on the FAILED start path too (see
  // runGateThenPublish), so a returning user whose engine will not bind ends the
  // launch having published `ready` with a dead engine behind it.
  //
  // needsWindow('ready') is false, and that was correct on its own terms -- a
  // successful returning launch must not pop a window open on every launch. But
  // applied to a FAILED one it means the fault note renders into a window
  // AppDelegate orderOut'd at startup, on an app with no status item yet. The
  // user sees nothing at all.
  it('brings the window forward for a start fault even when the decision says ready', () => {
    const rows: [string, boolean][] = [
      // ready, nothing failed: STILL false. The no-pop-on-returning-launch rule
      // must not regress into "always open a window".
      ['ready, no fault', needsWindowFor({ kind: 'ready' }, null)],
      // The load-bearing cell, and the whole reason needsWindowFor exists.
      ['ready WITH a fault', needsWindowFor({ kind: 'ready' }, 'address already in use')],
      // Unchanged from needsWindow, with or without a fault.
      ['onboard', needsWindowFor({ kind: 'onboard' }, null)],
      ['onboard with a fault', needsWindowFor({ kind: 'onboard' }, 'boom')],
      ['fault', needsWindowFor({ kind: 'fault', message: 'locked' }, null)],
      // Nothing decided yet, and nothing started, so nothing to show.
      ['undefined', needsWindowFor(undefined, null)],
    ];
    expect(rows).toEqual([
      ['ready, no fault', false],
      ['ready WITH a fault', true],
      ['onboard', true],
      ['onboard with a fault', true],
      ['fault', true],
      ['undefined', false],
    ]);
    // And needsWindow itself is UNCHANGED: it still knows nothing about a start
    // fault, because it is the decision-only rule and index.js now calls the
    // fault-aware one. If this ever flips, the two rules have been conflated.
    expect(needsWindow({ kind: 'ready' })).toBe(false);
  });
});

describe('desktop onboarding phases', () => {
  it('renders nothing until the read resolves', () => {
    expect(phaseFor(undefined)).toBe('loading');
    expect(phaseFor({ kind: 'onboard' })).toBe('onboarding');
    expect(phaseFor({ kind: 'ready' })).toBe('ready');
    expect(phaseFor({ kind: 'fault', message: 'x' })).toBe('fault');
  });
});

/**
 * WHAT A WINDOW DRAWS, which is not the phase.
 *
 * The defect this table exists for: `ready` was treated as permission to mount
 * the live shell, but a start can fail AFTER `ready` is published -- and then
 * `ready` is true while the engine is down, and the dashboard renders an empty
 * Devices tab that reads as healthy. So the drawing consults the fault store as
 * well as the phase.
 *
 * It is a table and not a rendered component here because it is pure, and the
 * rendered half of the same rule (that the child is genuinely absent from the
 * tree) is test/gate-render.spec.ts. Two tests, two levels, neither vacuous.
 */
describe('what a desktop window draws for each phase and fault', () => {
  it('draws nothing while the read is in flight', () => {
    expect(shellViewFor('loading', null)).toBe('nothing');
    // Even with a fault recorded: nothing has been decided, so there is
    // nothing truthful to say yet, and the window is orderOut anyway.
    expect(shellViewFor('loading', 'boom')).toBe('nothing');
  });

  it('draws the flow on a first launch, and never the shell', () => {
    expect(shellViewFor('onboarding', null)).toBe('flow');
    // A fault cannot coexist with an un-started engine, and if it somehow did,
    // the flow is not the answer: the engine's words are.
    expect(shellViewFor('onboarding', 'boom')).toBe('flow');
  });

  it('draws the shell ONLY when ready and nothing failed', () => {
    expect(shellViewFor('ready', null)).toBe('shell');
    // The load-bearing cell.
    expect(shellViewFor('ready', 'address already in use')).toBe('faulted');
  });

  it('draws the read fault as its own note', () => {
    expect(shellViewFor('fault', null)).toBe('faulted');
    expect(shellViewFor('fault', 'keychain locked')).toBe('faulted');
  });
});

describe('desktop permission rows', () => {
  // The prototype's sc-permissions has three switches and gates Continue on two
  // of them. On a Mac none of the three can be changed: discovery is a side
  // effect of start(), receiving has no preference, and the banner belongs to
  // the OS. So every row is 'unavailable' -- a rendered switch that flips into
  // a state nothing implements is a lie with a control on it.
  it('reports every capability rather than offering a switch that changes nothing', () => {
    const { rows } = desktopPermissionRows({});
    expect(rows.map((r) => r.key)).toEqual(['show-on-network', 'accept-files', 'alerts']);
    expect(rows.every((r) => r.state === 'unavailable')).toBe(true);
    // Nothing can be acted on, so Continue is never gated.
    expect(desktopPermissionRows({}).stillNeeded).toEqual([]);
  });

  it('reports the real banner answer when the host knows it', () => {
    expect(desktopPermissionRows({ notifications: true }).rows[2].sub)
      .toContain('will show a banner');
    expect(desktopPermissionRows({ notifications: false }).rows[2].sub)
      .toContain('Turned off');
  });

  it('never claims a sound preference, which this build does not have', () => {
    const titles = desktopPermissionRows({}).rows.map((r) => r.title.toLowerCase()).join(' ');
    expect(titles).not.toContain('sound');
  });
});

describe('the desktop first-run flow imports nothing mobile', () => {
  const SRC = join(__dirname, '..', 'src');
  const read = (name: string) => readFileSync(join(SRC, name), 'utf8');
  const flow = read('onboarding-flow.tsx');
  const gate = read('onboarding-gate.tsx');
  const engine = read('onboarding.ts');
  /** IMPORT SPECIFIERS ONLY. These files discuss what they deliberately do NOT
   *  import, in prose, at length -- matching the bare words would fail on the
   *  very comments that explain the rule. */
  const importsOf = (source: string) =>
    [...source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const specifiers = [...importsOf(flow), ...importsOf(gate), ...importsOf(engine)];

  // The mobile flow is the obvious thing to reach for and the wrong thing to
  // copy. It embeds <PairingFlow/>, which arms a pairing slot and renders a QR
  // meant to be read by a phone camera -- neither of which exists on a Mac.
  // More concretely, importing it would resolve TurboModules the macOS host
  // does not register, and Metro would refuse to build.
  it('never imports the mobile pairing flow or a camera scanner', () => {
    expect(specifiers.join(' ')).not.toMatch(/PairingFlow|camera|CameraScanner|vision-camera/);
  });

  // The prototype draws a QR and a six-digit code on the phone's first-run
  // pairing step. A drawn QR that encodes nothing, or a SAS picked to look
  // right, is the single most dangerous thing to port: both look real and both
  // are lies about a security handshake this build has to perform for real.
  it('renders no QR and no SAS of its own', () => {
    expect(specifiers.join(' ')).not.toMatch(/QrView|qr-code|QRCode|shortAuthString/);
    // And nothing DRAWS one: the mobile QR/SAS screens live in @daak/ui, which
    // is imported for layout primitives here, so the screen NAMES are checked
    // rather than the specifiers.
    expect(flow).not.toMatch(/<QrView/);
  });

  // The desktop rows are built HERE rather than imported from @daak/platform,
  // whose permissionRows() binds its switchable alerts row to
  // initNotifications() -- a MOBILE native module. Importing the barrel would
  // also drag in qr/securestore/notify/bgsched/share, each of which resolves a
  // TurboModule at module-eval time.
  it('builds its own rows instead of importing the mobile permission set', () => {
    // The barrel is the real hazard: it re-exports qr/securestore/notify/
    // bgsched/share, each of which resolves a TurboModule at module-eval time
    // that the macOS host does not register.
    expect(specifiers).not.toContain('@daak/platform');
    // The rows come from desktop's OWN builder.
    expect(flow).toMatch(/desktopPermissionRows/);
    // initNotifications() is the mobile native call behind the switchable row;
    // checked as an import, because both files explain in prose why it is not
    // used here.
   expect(specifiers.join(' ')).not.toMatch(/permission-rows|notify|initNotifications/);
 });
});

/**
 * THE ORDERING BUG THIS EXISTS FOR.
 *
 * index.js used to publish `ready` and THEN call startEngineOnce, on both
 * the returning-user path and the first-launch completion path.
 *
 * `publishOnboardingDecision({kind:'ready'})` is what swaps both windows
 * from the gate to `DaakUiApp` -- and DaakUiApp asks the engine for a device
 * list on its first render. Publishing before start() resolved therefore
 * mounted the live shell against an engine that was not up: an empty Devices
 * tab, and on the popover (which a human opens by clicking) no explanation at
 * all. No screenshot would catch it, because an empty device list is exactly
 * what a Mac alone on a network looks like.
 *
 * runGateThenPublish is the fix, and the property worth pinning is that the
 * publish is not merely late but strictly AFTER the await has settled.
 */
describe('publishing ready only after the engine is up', () => {
  it('publishes after start, name, and prime have all run', async () => {
    const order: string[] = [];
    await runGateThenPublish(
      { kind: 'ready', displayName: 'Darshit\'s MacBook' },
      {
        start: async () => {
          order.push('start');
        },
        applyName: async () => {
          order.push('setDisplayName');
        },
        prime: () => {
          order.push('prime');
        },
      },
      (decision) => {
        order.push('publish:' + decision.kind);
      },
    );
    expect(order).toEqual(['start', 'setDisplayName', 'prime', 'publish:ready']);
  });

  // The subtle one: `start` is async, so publishing immediately after
  // CALLING it still lands before start() resolves. Only awaiting pins it.
  it('does not publish while start is still in flight', async () => {
    const order: string[] = [];
    let releaseStart!: () => void;
    const started = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const run = runGateThenPublish(
      { kind: 'ready' },
      {
        start: () => started,
      },
      (decision) => {
        order.push('publish:' + decision.kind);
      },
    );
    // Let the microtask queue drain: the gate has called start() by now, and
    // if it published without awaiting, this is where it would already show.
    await Promise.resolve();
    expect(order).toEqual([]);
    releaseStart();
    await run;
    expect(order).toEqual(['publish:ready']);
  });

  // Publishing on a FAILED start is deliberate, and this test is here so a
  // future reader does not "fix" it. Staying in `loading` renders null, so
  // swallowing the failure would leave a blank window with nothing on it.
  //
  // What publishing means has CHANGED since this test was written, though, and
  // the distinction matters: `ready` here is not a claim that an engine came
  // up. It is a claim that the launch has finished deciding. The DRAWING is
  // what consults the fault -- shellViewFor('ready', fault) is 'faulted', not
  // 'shell' -- so the window shows the engine's own words and mounts no
  // dashboard over them. A reviewer showed the old version of that arrangement
  // mounted the live shell against a dead engine.
  //
  // What the ordering rule DOES forbid is publishing ready BEFORE start()
  // settles, which is the test above. A start that failed still resolves
  // false, and reportStartFault has already recorded the engine's words.
  it('still publishes when the start fails, so the fault note can render', async () => {
    const published: string[] = [];
    const started = await runGateThenPublish(
      { kind: 'ready' },
      {
        start: async () => {
          throw new Error('engine said no');
        },
      },
      (decision) => {
        published.push(decision.kind);
      },
    );
    expect(started).toBe(false);
    expect(published).toEqual(['ready']);
  });

  it('publishes a first launch and a fault through, starting neither', async () => {
    for (const decision of [{ kind: 'onboard' } as const, { kind: 'fault', message: 'locked' } as const]) {
      const { calls, deps } = tracer();
      const published: string[] = [];
      await runGateThenPublish(decision, deps, (d) => {
        published.push(d.kind);
      });
      expect(calls).toEqual([]);
      expect(published).toEqual([decision.kind]);
    }
  });
});

/**
 * index.js is not importable here -- it calls createEngine() and
 * AppRegistry.registerComponent at module scope, which need the native
 * bridge. So the two ORDERING facts that live there are pinned on its
 * source instead, the way macos-inprocess-ffi.spec.ts already pins the
 * engine shape. Source-order assertions are a last resort; these two are
 * worth it because each bug was invisible at runtime.
 */
describe('index.js routes both paths through the gate', () => {
  const index = readFileSync(join(__dirname, '..', 'index.js'), 'utf8');

  it('never calls publishOnboardingDecision with ready on its own', () => {
    // The bug's exact shape: a `publish` line that is not the injected
    // callback argument to runGateThenPublish.
    expect(index).not.toMatch(/publishOnboardingDecision\(\{\s*kind:\s*'ready'/);
  });

  it('passes the window-forwarding publisher into runGateThenPublish', () => {
    // publishDesktopDecision, NOT publishOnboardingDecision: the gate's
    // publisher has to bring the window forward for the decisions that need
    // one (see needsWindow), and passing the raw store call would silently drop
    // that. A source pin is the only way to see which of the two was injected.
    expect(index).toMatch(/runGateThenPublish\([\s\S]*publishDesktopDecision,\s*\)/);
    expect(index).not.toMatch(/runGateThenPublish\([\s\S]*?,\s*publishOnboardingDecision,\s*\)/);
  });

  // The wrapper is the only thing that opens a window on a first launch, and
  // window-host's openDashboard resolves EMPTY when DaakWindowHost is absent --
  // observably the same as not opening it. So this pins that the real host call
  // is what the wrapper reaches.
  //
  // needsWindowFor(decision, currentStartFault()), and the FAULT argument is the
  // load-bearing half: `ready` is published on a failed start too, so a bare
  // needsWindow(decision) left the fault view rendering into an orderOut window
  // on a menu-bar app with no Dock icon. currentStartFault is the store index.js
  // itself reports into, so this is the same fact the gate draws from.
  it('brings the window forward through the real host call', () => {
    const at = index.indexOf('function publishDesktopDecision(');
    expect(at).toBeGreaterThan(-1);
    const body = index.slice(at, index.indexOf('\n}', at));
    expect(body).toMatch(/publishOnboardingDecision\(decision\)/);
    expect(body).toMatch(/needsWindowFor\(decision, currentStartFault\(\)\)[\s\S]*openDashboard\(\)/);
    // The fault-aware wrapper, not the bare decision rule -- checked as a call
    // so a needsWindow(decision) left behind here cannot stand in for it.
    expect(body).not.toMatch(/[^\w.]needsWindow\(/);
    // And the store it reads is the one reportStartFault writes.
    expect(index).toMatch(/import \{[^}]*currentStartFault[^}]*\} from '\.\/src\/start-fault'/);
  });

  // DEFECT 3, introduced and caught in the same session: the completer used to
  // call startEngineOnce AFTER completeFirstRun had already consumed the start
  // claim. startEngineOnce then lost its own race, published nothing, and the
  // user was left sitting on the permissions screen of an app whose engine was
  // already running -- no dashboard, no error, and the answers already saved.
  //
  // The one-shot guard was doing its job; it was just being consulted by the
  // wrong function for the wrong job. So the pin is on the ORDER of the three
  // steps in the completer body itself: publish happens after the awaited
  // completion, and NOT through startEngineOnce.
  it('publishes ready from the completer without a second start race', () => {
    const at = index.indexOf('registerOnboardingCompleter(');
    expect(at).toBeGreaterThan(-1);
    const body = index.slice(at, index.indexOf('\n});', at));
    // The completion is AWAITED, so publish cannot run before the write and the
    // start have settled.
    expect(body).toMatch(/await completeFirstRun\(/);
    const completedAt = body.indexOf('await completeFirstRun(');
    const publishAt = body.indexOf("publishDesktopDecision({ kind: 'ready'");
    expect(publishAt).toBeGreaterThan(completedAt);
    // And only on success: a refused write must leave the flow on screen with
    // its note rather than swapping it for a dashboard.
    const guardAt = body.indexOf('if (!outcome.ok) return outcome;');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(publishAt);
    // The dead version: a CALL here would re-enter the claim completeFirstRun
    // just spent. Matched as a call, not as a word, because these files explain
    // in prose which functions must NOT be called -- matching the bare name
    // would fail on the very comment that records the rule.
    expect(body).not.toMatch(/[^\w]startEngineOnce\s*\(/);
  });

  // DEFECT 1: startEngineOnce is reachable from BOTH the returning-user gate
  // and the first-run completer, and neither is the only one. engine.start()
  // sat behind no guard at all, so a launch whose keystore read AND whose flow
  // completion both resolved to ready would bind twice.
  //
  // The Swift half is not idempotent about it: Daak.swift builds a NEW
  // DaakEngine.newWithStore and calls e.start() on it every time, so a second
  // call is a second engine over the same data dir, not a no-op.
  //
  // The pin is on the CLAIM being inside startEngineOnce's own body, not merely
  // somewhere in the file: a claim placed in one of the two callers would guard
  // one path and leave the other open, which is exactly the bug.
  //
  // THE EXACT COUNT, and not a substring search. The previous version of this
  // assertion accepted `claimEngineStart|once(` -- an alternation, so a stray
  // `once(` anywhere in the function satisfied it, and it only checked that the
  // text `engine.start()` appeared SOMEWHERE. A reviewer added a second,
  // unguarded `engine.start()` on its own line beside the claim -- the exact
  // double-bind the whole apparatus exists to prevent -- and all 38 tests
  // passed. So: exactly one `engine.start()` in the whole executable file, and
  // it is not spelled out inside startEngineOnce itself.
  it('guards the single engine start against a second caller', () => {
    const at = index.indexOf('function startEngineOnce(');
    expect(at).toBeGreaterThan(-1);
    // Comments stripped: this function's own comment block explains at length
    // why a bare engine.start() must never appear here, so an unstripped
    // search would find the rule written down and fail on the very prose that
    // records it.
    const code = stripComments(index);
    const codeAt = code.indexOf('function startEngineOnce(');
    const body = code.slice(codeAt, code.indexOf('\n}', codeAt));
    // The claim is reached, by name.
    expect(body).toMatch(/claimEngineStart/);
    // ...and no raw engine.start() is spelled out inside startEngineOnce. The
    // only legitimate start in this function is the CLAIM's, which lives in
    // claimEngineStart's own body. Matched as a call, and negated, because these
    // files explain in prose that a bare engine.start() must never appear here.
    expect(body).not.toMatch(/[^\w.\$]engine\.start\(\)/);
  });

  // The companion to the assertion above, and the part that actually catches
  // the double bind: ONE executable engine.start() in the whole file. Comments
  // and JSDoc discuss it at length (index.js:79, :82, :118, :121, :227), so the
  // source is stripped of comments first -- otherwise the count would be the
  // number of times the rule is written down rather than the number of times it
  // is followed.
  it('calls engine.start() exactly once in the executable app', () => {
    const code = stripComments(index);
    const starts = code.match(/[^\w.\$]engine\.start\(\)/g) ?? [];
    expect(starts).toHaveLength(1);
    // And it is INSIDE the claim, which is the only guarded thing in the app.
    const claimAt = code.indexOf('const claimEngineStart = once(');
    const startAt = code.indexOf('engine.start()');
    expect(claimAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(claimAt);
  });

  // DEFECT 4: the gate had NO one-shot guard, where apps/mobile's OnboardingFlow
  // has had one all along (OnboardingFlow.tsx:101, `completed = useRef(false)`).
  // Both desktop exits are Pressables -- "Look around first" on welcome and
  // "Continue" on permissions -- and a double tap fires BOTH. claimEngineStart
  // only guards the START half: two writes with two different names could still
  // land, and the last one would win silently.
  //
  // The BEHAVIOUR is now rendered and fired in test/gate-render.spec.ts, which
  // is where it belongs: this used to be a source pin, and a reviewer deleted
  // the guard ASSIGNMENT, then the guard RELEASE, one at a time, and the whole
  // suite stayed green -- because a regex cannot see whether a ref is ever
  // written. What is left here is the one thing that is genuinely about the
  // file's text: that the guard is a REF and not state, since a re-render
  // between the tap and the write would reset state and undo it.
  it('guards the completion against a double tap, like the mobile flow does', () => {
    const gate = readFileSync(join(__dirname, '..', 'src', 'onboarding-gate.tsx'), 'utf8');
    expect(gate).toMatch(/useRef/);
    expect(gate).toMatch(/if \([^)]*\.current\)\s*return;/);
  });

  // DEFECT 5: the gate awaited completeOnboarding with a one-armed .then(), so
  // a REJECTED completer became an unhandled rejection. completeFirstRun
  // catches the keystore rejection itself, so this is latent rather than
  // active -- but registerOnboardingCompleter is a registration point, and a
  // completer that throws would take the launch down silently, leaving the user
  // on the permissions screen with no note at all.
  it('handles a rejected completion instead of leaving it unhandled', () => {
    const gate = readFileSync(join(__dirname, '..', 'src', 'onboarding-gate.tsx'), 'utf8');
    // Two arguments on the completion promise: one for the outcome, one for the
    // explosion. Matched as a comma-separated SECOND ARROW rather than as a
    // bare character count, so this pins the shape instead of the formatting.
    // The gap between the comma and the arrow is loose because these files put a
    // comment there explaining WHY the second arm exists.
    expect(gate).toMatch(
      /completeOnboarding\(result\)\s*\.then\([\s\S]*?,\s*(?:\/\/[^\n]*\n\s*)*\(error[^)]*\)\s*=>/,
    );
    // And the handler puts something on screen.
    expect(gate).toMatch(/setWriteFailure\(/);
  });

  /**
   * DEFECT 1, PINNED ON THE REAL CLOSURES -- the gap this file was still
   * carrying.
   *
   * The test above ('fails honestly when the start claim was already spent')
   * exercises a HAND-COPIED replica of index.js's start closure, transcribed
   * into completeFirstRun's `start`. A replica cannot drift, and it also cannot
   * fall behind: a reviewer deleted `if (!won) throw` from EITHER real closure
   * in index.js and every test here stayed green, because nothing was reading
   * index.js's own text.
   *
   * So this reads the real file. BOTH closures, each located by its own anchor:
   * one inside 'function startEngineOnce(', one inside 'registerOnboardingCompleter('.
   * Each stripped body must contain the claim AND a check of its answer --
   * /const won = await claimEngineStart\(\)/ and then /if \(!won\)\s*throw/ AFTER
   * it, so a claim whose boolean is merely discarded cannot satisfy it.
   *
   * The strip is load-bearing here too: index.js explains in prose, on the
   * lines above each closure, exactly why the throw must stay. Without the strip
   * this assertion would be satisfied by the comment describing the fix.
   */
  it('checks the start claim in BOTH real closures in index.js', () => {
    const code = stripComments(index);
    const claim = /const won = await claimEngineStart\(\)/;
    const check = /if \(!won\)\s*throw/;
    const closures = ['function startEngineOnce(', 'registerOnboardingCompleter('];
    for (const anchor of closures) {
      const at = code.indexOf(anchor);
      expect(at, `anchor ${anchor} not found in index.js`).toBeGreaterThan(-1);
      // Bounded by the NEXT anchor, so the second closure's check can never
      // stand in for the first's. startEngineOnce is defined before
      // registerOnboardingCompleter, so slicing forwards from each anchor
      // reads its own body and nothing past the other one.
      const other = closures[1 - closures.indexOf(anchor)];
      const nextAt = code.indexOf(other, at);
      const region = regionContaining(code.slice(at, nextAt === -1 ? undefined : nextAt), claim);
      expect(region, `no claimEngineStart inside ${anchor}`).not.toBe('');
      const claimAt = region.search(claim);
      const checkAt = region.slice(claimAt).search(check);
      expect(
        checkAt,
        `the claim inside ${anchor} is not checked: 'const won = await claimEngineStart()' must be followed by 'if (!won) throw'`,
      ).toBeGreaterThan(-1);
    }
  });
});
