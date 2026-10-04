import React, { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';
import { Note, ui } from '@daak/ui';
import { DesktopOnboardingFlow, type CompletedOnboarding } from './onboarding-flow';
import { completeOnboarding, currentOnboardingDecision, useOnboardingPhase } from './onboarding-store';
import { shellViewFor } from './onboarding';
import { StartFaultNote, useStartFault } from './start-fault';

/**
 * What the desktop windows render INSTEAD of the dashboard until this Mac has
 * been onboarded.
 *
 * Four phases, and the middle one is the only interesting one:
 *
 *  - loading: the keystore read is in flight. Renders NOTHING at all, rather
 *    than a spinner or a blank hold. Both windows are built at launch (the
 *    dashboard by AppDelegate, the popover when the status item is clicked),
 *    and anything drawn during this phase is drawn against a decision that
 *    does not exist yet -- a flash of empty dashboard is worse than a beat of
 *    nothing, because an empty dashboard reads as "no devices nearby".
 *
 *  - onboarding: the prototype's welcome flow. No engine is running.
 *
 *  - fault: the keystore refused the read. Nothing was started and nothing was
 *    written (src/onboarding.ts explains why a locked keychain must not read as
 *    a first launch), so this says exactly that instead of offering a button
 *    that would begin a first-run overwrite.
 *
 *  - ready: render the real shell -- UNLESS the engine is recorded as dead,
 *    which is what shellViewFor's `faulted` answer is for. See below.
 *
 * WHY CHILDREN ARE NOT MOUNTED EARLY: the dashboard tree must not exist before
 * the engine starts. A mounted DaakUiApp subscribes to the runtime and asks an
 * unstarted engine for a device list on its first render.
 *
 * WHY `ready` IS NOT ENOUGH ON ITS OWN: a start can FAIL after the decision is
 * published -- a port already in use, a data dir that will not bind -- and then
 * `ready` is true while the engine is down. Rendering children on that pair
 * mounts the live dashboard over a dead engine: an empty Devices tab that says
 * "nothing nearby", which reads as healthy. So the gate consults the fault
 * store as well as the phase, and draws the note INSTEAD OF the shell. The
 * window is still open and still says what went wrong; it just does not pretend
 * to be a working app.
 *
 * WHY `onboarding` IS NOT ENOUGH ON ITS OWN EITHER: a first launch finishes its
 * flow, the write lands, the engine does NOT start, and the phase is still
 * `onboarding` -- nothing published `ready`, so phaseFor cannot see it. The gate
 * has to consult the fault store there too, or the user is left looking at the
 * UNCHANGED welcome screen with pressable-but-dead buttons and no explanation.
 * That is a terminal failure with no way out of it visible, so it draws the
 * start-fault note INSTEAD of the flow. See the branch below.
 */
export function DesktopOnboardingGate({ children }: { children: React.ReactNode }) {
  const phase = useOnboardingPhase();
  const startFault = useStartFault();
  // Local state, not store state: this failure appears only after the user has
  // interacted with the flow, and a later launch with a writable keychain must
  // not be shown yesterday's write failure.
  const [writeFailure, setWriteFailure] = useState<string | undefined>(undefined);
  // Guards the one-shot completion, matching apps/mobile/src/OnboardingFlow.tsx:101.
  // Both exits here are Pressables -- "Look around first" and "Continue" -- and
  // a double tap fires both. index.js's claimEngineStart guards only the START
  // half of that: two writes with two different names would still both land,
  // and the second would silently win. A ref rather than state because it is
  // read and written inside one synchronous handler with no render between.
  const completed = useRef(false);

  const onComplete = useCallback((result: CompletedOnboarding) => {
    if (completed.current) return;
    completed.current = true;
    const note = (message: string, retryable: boolean) => {
      // The flow stays exactly where it is. Moving on would mean telling a user
      // their answers were kept when they were not, and they would be asked the
      // same three questions on every launch, forever.
      //
      //
      // THE SLOT IS RELEASED ONLY FOR A WRITE FAILURE, and that is the fix for a
      // defect this handler had half of. Holding the guard unconditionally was
      // correct for an engine start failure -- a reviewer proved that releasing
      // it there is a shipping defect, because index.js KEEPS a failed start
      // consumed (a half-bound data dir must not be bound twice), so the retry
      // hit an already-consumed claim, got a bare `false` instead of a throw, the
      // skip path has no applyName() to catch it, prime() ran against the dead
      // engine and the app published {ok:true}. But holding it for a WRITE
      // failure too made every save failure terminal: Continue and Skip stayed
      // pressable and did nothing, forever, with no way to try again. The two
      // events are now distinguishable (FirstRunOutcome.retryable), so the
      // guard is released exactly for the one where a retry is genuinely a first
      // attempt, and held for the one where it is not.
      setWriteFailure(message);
      if (retryable) completed.current = false;
    };
    void completeOnboarding(result).then(
      (outcome) => {
        if (outcome.ok) return;
        note(outcome.message ?? 'Daak could not save your choices on this Mac.', outcome.retryable);
      },
      // completeFirstRun catches the keystore rejection itself, so this arm is
      // belt-and-braces -- but registerOnboardingCompleter is a REGISTRATION
      // point: a completer that threw would otherwise become an unhandled
      // rejection, leaving the user on the permissions screen with no note at
      // all and nothing in the log they would ever read.
      //
      // RETRYABLE, because a completer that threw is not a reported engine
      // failure: completeFirstRun never ran to the point of consuming
      // claimEngineStart, so nothing is spent and a retry is safe. Treating it
      // as terminal would reintroduce the dead button this arm exists to avoid.
      (error: unknown) => {
        note(
          'Daak could not save your choices on this Mac (' +
            (error instanceof Error ? error.message : String(error)) +
            ').',
          true,
        );
      },
    );
  }, []);

  const view = shellViewFor(phase, startFault);

  if (view === 'nothing') return null;

  if (phase === 'fault') {
    return (
      <View style={[ui.screen, { padding: 16 }]} testID="desktop-onboarding-fault">
        <Note
          tone="err"
          title="Daak could not read this Mac"
          body={
            'Nothing has been started and nothing has been changed. Relaunch Daak to try again. ' +
            'What the check said: ' + readFaultMessage()
          }
        />
      </View>
    );
  }

  if (phase === 'onboarding') {
    // FIRST LAUNCH, THE FLOW FINISHED, THE ENGINE DID NOT START. Nothing has
    // published `ready` -- the write landed and the start failed inside
    // completeFirstRun -- so the phase is still `onboarding` and the flow is
    // still, byte for byte, the welcome screen the user just finished. Its
    // buttons are live (the guard above released nothing yet, and this failure
    // is non-retryable so it never will) and they would run the completion
    // again against an already-consumed claim. So the flow is NOT the answer
    // here; the engine's words and a real way out are.
    if (startFault !== null) {
      return <TerminalStartFault />;
    }
    return (
      <View style={{ flex: 1 }}>
        {writeFailure === undefined ? null : (
          <WriteFailureNote body={writeFailure} />
        )}
        <DesktopOnboardingFlow onComplete={onComplete} capabilities={{}} />
      </View>
    );
  }

  // READY BUT DEAD. The engine's own words, and nothing else mounted over
  // them. The user has a window (needsWindowFor brought it forward on the
  // fault, or the tray icon brought it forward on any later click) and a
  // reason; they do NOT get a Devices tab that looks like a working app.
  if (view === 'faulted') {
    return <TerminalStartFault />;
  }

  return <>{children}</>;
}

/**
 * A failed ENGINE START, on either of the two phases that can reach it.
 *
 * The engine's own words first, then the only instruction that actually works:
 * quitting and opening Daak again. The relaunch note is not decoration on the
 * read-failure path -- index.js's claimEngineStart is one-shot per launch and
 * deliberately stays consumed after a failure, so nothing inside THIS process
 * can start the engine again. "Try again" without "quit" is a lie.
 *
 * One component, used twice, so the two routes cannot drift into saying
 * different things about the same failure. The padding lives HERE rather than
 * around each call site, which is what stopped the faulted branch and
 * StartFaultNote each applying their own 16px and insetting the note twice.
 */
function TerminalStartFault() {
  return (
    <View style={[ui.screen, { padding: 16 }]} testID="desktop-start-fault">
      <StartFaultNote />
      <Note
        tone="err"
        title="Quit Daak and open it again"
        body="This launch has already tried to start its engine, and starting it twice on one data folder is not safe. Quit Daak and open it again to try once more."
      />
    </View>
  );
}

/**
 * A failed SAVE. Retryable, so it is deliberately a DIFFERENT note from the
 * terminal engine fault above and says so: "not saved" (press Continue again)
 * and "your choices were saved, the engine did not start" (quit and relaunch)
 * are different instructions, and a user who follows the wrong one is stuck.
 *
 * Also the single padding owner for this note. It is rendered as a bare child of
 * the flex column, so it needs its own inset -- and there is no paddingBottom:0
 * fudge, because ui.note already carries spacing.md inside itself and a zero
 * bottom edge just glued the note to the screen edge.
 */
function WriteFailureNote({ body }: { body: string }) {
  return (
    <View style={{ padding: 16 }}>
      <Note tone="err" title="That choice was not saved" body={body} />
    </View>
  );
}

/**
 * The engine's own words about the read failure.
 *
 * Read from the decision at RENDER time rather than copied into a second piece
 * of state, because two copies of one message is two things that can disagree.
 */
function readFaultMessage(): string {
  const decision = currentOnboardingDecision();
  return decision?.kind === 'fault' ? decision.message : '';
}
