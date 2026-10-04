/**
 * A module-level store for "should this window show onboarding yet?"
 *
 * WHY NOT useState IN A SHELL: both roots are registered with AppRegistry
 * (index.js:90-97) and are handed only the engine and the runtime. There is no
 * prop through which a later-resolving keystore read could deliver a phase, so
 * a shell that seeded its own state would keep rendering the dashboard for a
 * first launch that has not been onboarded yet. This is the same shape, and the
 * same reason, as `startFault` in src/start-fault.tsx:22.
 *
 * The read is ASYNC and happens once, at module scope in index.js, BEFORE the
 * engine is started. The store exists so that whichever tree is already mounted
 * re-renders when the answer arrives -- including a dashboard window that was
 * built at launch and merely orderOut afterwards (AppDelegate.mm).
 */
import { useCallback, useSyncExternalStore } from 'react';
import {
  phaseFor,
  type FirstRunOutcome,
  type OnboardingDecision,
  type DesktopOnboardingPhase,
} from './onboarding';
import type { CompletedOnboarding } from './onboarding-flow';

let decision: OnboardingDecision | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

export function publishOnboardingDecision(next: OnboardingDecision): void {
  decision = next;
  emit();
}

/** For tests. Resets to the pre-read state, which renders nothing. */
export function resetOnboardingDecision(): void {
  decision = undefined;
  emit();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/**
 * The stable snapshot. A FUNCTION rather than the phase itself, because
 * useSyncExternalStore compares snapshots with Object.is: returning a freshly
 * computed string each call would loop forever, and returning a mutable object
 * would hide real changes.
 */
function getSnapshot(): DesktopOnboardingPhase {
  return phaseFor(decision);
}

export function useOnboardingPhase(): DesktopOnboardingPhase {
  // useCallback, so the identity is stable: an inline arrow is a new function
  // every render, which would resubscribe on every store emission.
  const subscribeStable = useCallback((onChange: () => void) => subscribe(onChange), []);
  return useSyncExternalStore(subscribeStable, getSnapshot, getSnapshot);
}

/** The decision itself, for the one caller that has to act on it. */
export function currentOnboardingDecision(): OnboardingDecision | undefined {
  return decision;
}

/**
 * Who finishes onboarding: write the durable state, THEN start the engine.
 *
 * Registered rather than imported because the engine and runtime live in
 * index.js's closure. A shell could import them itself, but then two files
 * would own engine.start(), and the ordering rule that matters -- ask first,
 * start second -- would be duplicated exactly where it is easiest to get wrong.
 * One registration, one start site.
 *
 * The outcome type is imported rather than re-spelled, so a completer here
 * cannot drift from completeFirstRun's own: `retryable` is what the gate reads
 * to decide whether Continue is live or dead, and a hand-written local type is
 * where that flag would quietly go missing.
 */
let completer:
  | ((result: CompletedOnboarding) => Promise<FirstRunOutcome>)
  | undefined;

export function registerOnboardingCompleter(
  fn: (result: CompletedOnboarding) => Promise<FirstRunOutcome>,
): void {
  completer = fn;
}

/**
 * Runs the real completion. A missing completer is a wiring bug, not a user
 * error, so it reports as a failed write: the flow stays put rather than
 * pretending the answers were saved and leaving a returning user to be asked
 * again on every launch. It is reported as RETRYABLE because that is what it is
 * -- nothing was written, nothing was started, no claim consumed -- and the one
 * thing a wiring bug must not do is leave the user pressing a dead Continue.
 */
export async function completeOnboarding(
  result: CompletedOnboarding,
): Promise<FirstRunOutcome> {
  if (completer === undefined) {
    return {
      ok: false,
      retryable: true,
      message: 'Daak could not save your choices on this Mac.',
    };
  }
  return completer(result);
}
