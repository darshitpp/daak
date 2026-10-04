/**
 * "The engine did not start", as a store both windows can read, plus the one
 * component that puts it on screen.
 *
 * WHY A SEPARATE MODULE: two files need this fact, and one of them imports the
 * other. The fault is REPORTED from index.js (where the engine's own words
 * still are) and it has to be READ by the onboarding gate, which decides
 * whether to mount the live dashboard at all. Leaving it in shells.tsx would
 * make onboarding-gate.tsx import the shells that import the gate.
 *
 * WHY MODULE STATE rather than a prop: the roots are handed only the engine
 * and the runtime by AppRegistry, and a start failure happens after both have
 * mounted -- including the dashboard window, which is built at launch and only
 * orderOut afterwards (AppDelegate.mm). useState would be seeded long before
 * the failure arrived. This is the same shape, and the same reason, as the
 * onboarding decision store in onboarding-store.ts.
 */
import React, { useCallback, useSyncExternalStore } from 'react';
import { Note } from '@daak/ui';

let startFault: string | null = null;
const listeners = new Set<() => void>();

/** The engine's own words, not a generic "could not start". */
export function startFaultMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function reportStartFault(error: unknown): void {
  startFault = startFaultMessage(error);
  listeners.forEach((listener) => listener());
}

/** For tests. Back to "no fault", which is every launch that started. */
export function resetStartFault(): void {
  startFault = null;
  listeners.forEach((listener) => listener());
}

export function currentStartFault(): string | null {
  return startFault;
}

export function useStartFault(): string | null {
  // useCallback, so the identity is stable: an inline arrow is a new function
  // every render, which would resubscribe on every store emission.
  const subscribeStable = useCallback((onChange: () => void) => {
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  }, []);
  return useSyncExternalStore(subscribeStable, currentStartFault, currentStartFault);
}

/**
 * The fault, or nothing. A dead engine says nothing on screen by itself: no
 * peers, no transfers, no inbox, and no error -- the same reason
 * apps/mobile/src/App.tsx shows a note for it.
 */
export function StartFaultNote() {
  const fault = useStartFault();
  if (fault === null) return null;
  // NO WRAPPER VIEW. This used to render <View style={{padding:16,
  // paddingBottom:0}}> around the Note, and the gate's faulted branch wrapped
  // the whole thing in another {padding:16} -- a 32px double inset, which is
  // what a reviewer flagged. The caller owns the padding; ui.note already
  // carries spacing.md between the title and the body, so dropping the wrapper
  // removes the double inset without changing the note's internal spacing.
  return (
    <Note
      tone="err"
      title="Daak's engine did not start"
      body={`Nothing can be sent or received until this is fixed: ${fault}`}
    />
  );
}
