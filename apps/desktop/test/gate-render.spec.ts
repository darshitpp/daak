import React, { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopOnboardingGate } from '../src/onboarding-gate';
import {
  publishOnboardingDecision,
  registerOnboardingCompleter,
  resetOnboardingDecision,
} from '../src/onboarding-store';
import { reportStartFault, resetStartFault } from '../src/start-fault';

/**
 * THE GATE, ACTUALLY RENDERED.
 *
 * Everything else about this file's subject was pinned on SOURCE, and a
 * reviewer mutation-tested those pins into meaninglessness: deleting the guard
 * assignment, deleting the guard release, and removing the fault rendering all
 * left the suite green. A source pin cannot see whether a ref is ever written,
 * because the prose around it explains the rule perfectly well whether or not
 * the code does it.
 *
 * So these tests mount the gate and fire real handlers. They are possible
 * because test/react-native-stub.ts now exports the host components packages/ui
 * draws with, and react-test-renderer renders a string host type without
 * complaint.
 *
 * react-test-renderer is a DECLARED devDependency of this package, at the
 * version packages/ui and apps/mobile already pin. It used to be undeclared
 * here and resolved only through a hand-made absolute symlink in
 * node_modules -- a clean `pnpm install --frozen-lockfile` would not have
 * recreated it, so this file worked on one machine and nowhere else. That was
 * NOT the RN preset's doing, as this comment previously claimed: it reached
 * apps/desktop through packages/ui's hoisting, which is a coincidence, not a
 * declaration. test/declared-dependencies.spec.ts now keeps it declared.
 *
 * The child here is a MARKER, not a shell. Whether the marker is in the tree is
 * exactly the question D2 was about, and a marker answers it without needing a
 * running engine.
 */

const MARKER = 'LIVE-SHELL-WAS-MOUNTED';

function render() {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(React.createElement(DesktopOnboardingGate, null, MARKER));
  });
  return renderer;
}

/** The rendered tree, flattened to text, for "is this on screen" questions. */
function text(tree: ReactTestRenderer): string {
  return JSON.stringify(tree.toJSON() ?? null);
}

/**
 * Fires the prop of the first node carrying `testID`, as a tap would, then
 * lets every already-queued microtask settle so a completion's `.then` arm has
 * run before the next assertion.
 */
async function press(tree: ReactTestRenderer, testID: string): Promise<void> {
  const node = tree.root.findByProps({ testID });
  act(() => {
    (node.props as { onPress?: () => void }).onPress?.();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  resetOnboardingDecision();
  resetStartFault();
});

describe('the gate draws nothing until the keystore read resolves', () => {
  it('renders no child, no flow and no fault before a decision exists', () => {
    const tree = render();
    expect(tree.toJSON()).toBeNull();
  });
});

describe('the gate shows the first-run flow, and no shell, on a first launch', () => {
  it('renders the flow and never the child', () => {
    publishOnboardingDecision({ kind: 'onboard' });
    const tree = render();
    expect(tree.root.findByProps({ testID: 'screen-welcome' })).toBeTruthy();
    // The load-bearing half. A child mounted here would call engine.devices()
    // against an engine that has deliberately not been started.
    expect(text(tree)).not.toContain(MARKER);
  });
});

/**
 * D2, THE SHIPPING DEFECT. A start can fail AFTER the decision says `ready`,
 * and the two are separate facts. Rendering the child on that pair mounts the
 * live dashboard over a dead engine: an empty Devices tab reading "nothing
 * nearby", with no indication anything is wrong.
 */
describe('the gate refuses to mount the shell when the engine is recorded dead', () => {
  it('renders the fault, not the child, when ready came with a failed start', () => {
    publishOnboardingDecision({ kind: 'ready' });
    reportStartFault(new Error('address already in use'));
    const tree = render();
    // The engine's own words are on screen. Not a generic string: the note has
    // to be actionable, and "could not start" is not.
    expect(text(tree)).toContain('address already in use');
    // And the dashboard is NOT.
    expect(text(tree)).not.toContain(MARKER);
  });

  // The negative, without which the test above passes for the wrong reason: a
  // gate that rendered nothing at all would also not contain the marker.
  it('renders the child when ready comes with no fault', () => {
    publishOnboardingDecision({ kind: 'ready' });
    const tree = render();
    expect(text(tree)).toContain(MARKER);
  });
});

describe('a keystore fault is its own note, and starts nothing', () => {
  it('shows the read failure rather than the flow or the shell', () => {
    publishOnboardingDecision({ kind: 'fault', message: 'keychain locked' });
    const tree = render();
    expect(text(tree)).toContain('keychain locked');
    expect(text(tree)).not.toContain(MARKER);
    // And NOT the first-run flow: offering a button here would begin an
    // overwrite of a real user's state.
    expect(() => tree.root.findByProps({ testID: 'screen-welcome' })).toThrow();
  });
});

/**
 * D5, THE DOUBLE TAP. Both exits of the flow are Pressables, and a double tap
 * fires both. claimEngineStart guards only the START half, so two writes with
 * two different names would both land and the second would win silently.
 *
 * The guard is a ref read and written inside one synchronous handler with no
 * await between, so a second tap cannot interleave -- and that is EXACTLY the
 * thing a source pin cannot see. The reviewer deleted the assignment and the
 * release, one at a time, and the whole suite stayed green. Here the completer
 * is a spy and the assertion is on how many times it was called.
 */
describe('the gate refuses a double tap on the completion', () => {
  it('runs the completion once for two taps in the same act', () => {
    publishOnboardingDecision({ kind: 'onboard' });
    const complete = vi.fn(async () => ({ ok: true, retryable: false }));
    registerOnboardingCompleter(complete);
    const tree = render();

    // Both presses inside ONE act, so there is no await boundary between them
    // for React to flush on. Two acts would prove nothing about the ref: the
    // guard is synchronous and the bug was never about awaiting.
    const skip = tree.root.findByProps({ testID: 'welcome-skip' });
    act(() => {
      (skip.props as { onPress?: () => void }).onPress?.();
      (skip.props as { onPress?: () => void }).onPress?.();
    });

    expect(complete).toHaveBeenCalledTimes(1);
  });

  // A FAILED SAVE IS RETRYABLE, and this is the fix for a dead button. The old
  // version of this test asserted the guard stayed closed after ANY failed
  // completion; that premise was half wrong. Holding the guard is correct for an
  // engine start failure and wrong for a write failure: the write never landed
  // and no claim was consumed, so Continue and Skip stayed pressable and did
  // nothing for the rest of the launch. The two events are now distinguishable,
  // and this is the write half -- the completer is called again, and the second
  // call can succeed.
  it('releases the guard after a retryable failure, so a second press retries', async () => {
    publishOnboardingDecision({ kind: 'onboard' });
    const complete = vi.fn(async () => {
      // First press: the keychain refused. Second press: it took the write.
      if (complete.mock.calls.length === 1) {
        return { ok: false, retryable: true, message: 'keychain said no' };
      }
      // index.js publishes `ready` only after a real success, which is what
      // swaps this tree for the dashboard. Mirrored here so the second press
      // has somewhere to GO.
      publishOnboardingDecision({ kind: 'ready' });
      return { ok: true, retryable: false };
    });
    registerOnboardingCompleter(complete);
    const tree = render();

    await press(tree, 'welcome-skip');
    // The note is on screen, so the user can see why they are still here.
    expect(text(tree)).toContain('keychain said no');
    // And the second tap is NOT swallowed: it reaches the completer again.
    await press(tree, 'welcome-skip');
    expect(complete).toHaveBeenCalledTimes(2);
    // Which is the point: the retry is allowed to succeed, so a transient
    // keychain refusal is not a dead end. The success publishes `ready`, the
    // gate swaps to its children, and the flow is gone.
    expect(tree.root.findAllByProps({ testID: 'welcome-skip' })).toHaveLength(0);
    expect(text(tree)).toContain(MARKER);
  });
});

/**
 * A FAILED ENGINE START IS TERMINAL, and it is the other half of the split.
 *
 * Here the answers DID land and index.js's claimEngineStart is consumed for good
 * (a half-bound data dir must not be bound twice), so releasing the guard would
 * retry into a claim that returns false and report a success over a dead engine.
 * The guard therefore stays closed -- and, load-bearing, the user is not left on
 * the UNCHANGED welcome screen with dead buttons and no explanation. A start
 * failure during `onboarding` publishes nothing, so the phase never becomes
 * `ready`: the gate has to draw the engine fault itself.
 */
describe('the gate makes a failed engine start terminal, and visible', () => {
  async function failToStart(): Promise<{ tree: ReactTestRenderer; complete: () => number }> {
    publishOnboardingDecision({ kind: 'onboard' });
    const complete = vi.fn(async () => ({
      ok: false,
      retryable: false,
      message: 'Your choices were saved, but the engine did not start on this Mac.',
    }));
    registerOnboardingCompleter(complete);
    const tree = render();
    await press(tree, 'welcome-skip');
    // The engine own words reach the fault store, which is where index.js
    // reports them from -- not through the outcome message, which the gate does
    // not read for this.
    act(() => {
      reportStartFault(new Error('address already in use'));
    });
    return { tree, complete: () => complete.mock.calls.length };
  }

  it('shows the engine fault and a relaunch instruction instead of the flow', async () => {
    const { tree } = await failToStart();
    // The engine own words, verbatim. A generic string is not actionable.
    expect(text(tree)).toContain('address already in use');
    // And a real instruction, not a bare try-again: nothing in this process can
    // start the engine again, so the only way through is a relaunch.
    expect(text(tree)).toContain('Quit Daak and open it again');
    // The load-bearing half. The flow is GONE -- its buttons are live and they
    // would run the completion again against a consumed claim.
    expect(() => tree.root.findByProps({ testID: 'screen-welcome' })).toThrow();
  });

  it('keeps the guard closed, so the terminal failure cannot be retried', async () => {
    const { tree, complete } = await failToStart();
    // Nothing to press: the flow is not rendered, so there is no second press to
    // catch. And the completer -- what a released guard would have re-invoked --
    // ran exactly once.
    expect(() => tree.root.findByProps({ testID: 'welcome-skip' })).toThrow();
    expect(complete()).toBe(1);
  });
});

/**
 * The store is module state, so a test that publishes a decision and leaves it
 * behind would decide the next test. beforeEach resets both stores; this pins
 * that the reset is real, so a green suite is not resting on ordering.
 */
describe('the gate stores are resettable, so no test inherits a decision', () => {
  it('returns to rendering nothing after a reset', () => {
    publishOnboardingDecision({ kind: 'ready' });
    const tree = render();
    expect(text(tree)).toContain(MARKER);
    act(() => {
      resetOnboardingDecision();
    });
    expect(tree.toJSON()).toBeNull();
  });
});
