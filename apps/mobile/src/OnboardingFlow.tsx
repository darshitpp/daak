import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import {
  Btn,
  NameDeviceScreen,
  Note,
  PairFirstDeviceScreen,
  PermissionsScreen,
  DownloadFolderRow,
  WelcomeScreen,
  useEngine,
  ui,
  type PermissionRowSpec,
} from '@daak/ui';
import {
  INITIAL_ONBOARDING,
  permissionRows,
  chooseDownloadFolder,
  clearDownloadFolder,
  downloadFolderName,
  readOnboarding,
  withNotificationReask,
  writeOnboarding,
  type OnboardingState,
} from '@daak/platform';
import { notificationGrant, recordNotificationGrant } from './bootstrap';
import { PairingFlow } from './PairingFlow';

type Step = 'loading' | 'welcome' | 'name' | 'permissions' | 'starting' | 'pair' | 'done' | 'fault';

/**
 * The prototype's first-run flow, wired to the real keystore and the real
 * engine.
 *
 * ORDERING IS THE WHOLE POINT, and it is the opposite of what App.tsx did
 * before. Previously the engine started on mount and the shell rendered
 * immediately. Now the durable onboarding state is read FIRST, because the
 * engine cannot be started until the device has a name -- publishing a name
 * requires a started engine, and asking for a name requires not having asked
 * before, which requires reading the keystore first.
 *
 * Nothing is written until a read has RESOLVED. readOnboarding propagates a
 * keystore rejection deliberately (onboarding.ts explains why), and writing on
 * a read that threw would overwrite a real user's state with a first-launch
 * default because the keychain happened to be locked.
 *
 * THIS COMPONENT OWNS NO ENGINE. The earlier version took one and started it
 * itself, which put the ordering rule in two files and produced a real bug:
 * reaching the pairing step without a running engine, so armHostPairing would
 * fail on the one device being paired for the first time. There is exactly one
 * engine-start call site in the app now, and reaching the end of this flow is a
 * single durable write followed by one callback. Two writes racing for the
 * completion flag is the state this shape removes too: the Welcome skip and the
 * Pair skip are the same transition now.
 */
export function OnboardingFlow({ onComplete, onReady }: {
  /**
   * Called ONCE, after the durable write that marks onboarding complete has
   * resolved true. Never before: a caller that started an engine on a write
   * that then failed would publish a name it could not remember.
   */
  onComplete: () => void;
  /**
   * Called the moment the durable state first permits the engine to start.
   *
   * A separate callback from onComplete because pairing happens BEFORE the flow
   * finishes and pairing needs a live engine: armHostPairing arms a slot on an
   * engine that has not been started and resolves against nothing, which is why
   * the very first device a user pairs used to be the one device they could not
   * pair. Waiting for onComplete would mean no engine for the whole pairing
   * step.
   *
   * It fires from TWO writes, and both are genuine permissions to start. The
   * Permissions step writes a chosen name, which is the strict case: from here
   * the engine can publish the name the user picked. The Welcome skip writes
   * completion with no name, and that also permits a start -- the user said
   * this phone was already set up, so the machine-generated name is what they
   * are accepting, and refusing to start would leave them on a shell they can
   * never use.
   */
  /**
   * Called when the durable state first permits the engine to start.
   *
   * Returns a promise that resolves once the engine is USABLE. It is awaited
   * before the pairing step renders and before the Welcome skip completes,
   * because pairing arms an accept slot on the engine: arming against an
   * engine that is still starting fails, and the device being paired for the
   * first time is exactly the device with no pairing row to fall back on.
   *
   * A caller that resolves early (or never resolves) reintroduces that bug in
   * a form no test of this component would catch, so the type here is a promise
   * deliberately, not a void.
   */
  onReady?: (chosenName?: string) => Promise<void>;
}) {
  const [step, setStep] = useState<Step>('loading');
  const [state, setState] = useState<OnboardingState>(INITIAL_ONBOARDING);
  const [name, setName] = useState('');
  const [granted, setGranted] = useState<boolean | undefined>(undefined);
  const [fault, setFault] = useState('');
  // Guards the one-shot completion. Both skip buttons are Pressables, and a
  // double tap on either would otherwise write twice and call onComplete
  // twice, which on the App side is a second setOnboarded call and a wasted
  // engine start. A ref rather than state because it is read and written inside
  // one synchronous handler with no render in between.
  const completed = useRef(false);
  const engine = useEngine();

  useEffect(() => {
    let cancelled = false;
    void readOnboarding().then(
      (stored) => {
        if (cancelled) return;
        setState(stored);
        setName(stored.name ?? '');
        setStep(stored.complete ? 'done' : 'welcome');
      },
      (e: unknown) => {
        if (cancelled) return;
        setFault(e instanceof Error ? e.message : String(e));
        setStep('fault');
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const failWith = useCallback((message: string) => {
    setFault(message);
   setStep('fault');
 }, []);

  /**
   * The single exit. The flow's own state is spread forward so the completion
   * write carries the name and the alert answer rather than resetting them:
   * resetting alerts here would silently undo a grant the user just gave.
   */
  const finish = useCallback(
    (patch: Partial<OnboardingState>) => {
      if (completed.current) return;
      const next: OnboardingState = { ...state, ...patch, complete: true };
      void writeOnboarding(next).then(
        (ok) => {
          if (!ok) {
            // Nothing is committed and the flow stays where it is, because a
            // completion that cannot be remembered would ask every question
            // again on the next launch.
            failWith('This device would not save that, so Daak would ask again every launch.');
            return;
          }
          completed.current = true;
          setState(next);
          // AWAITED, not called and forgotten. This is the invariant that makes
          // the pairing step reachable at all: onComplete flips App to the
          // shell, and the shell asks the engine for a device list on its first
          // render. Completing before boot() resolved would show an empty
          // Devices tab for a launch. The write has already landed, so a
          // failure here is reported by App's own fault note, not re-written.
          void (onReady?.() ?? Promise.resolve()).then(onComplete);
        },
        (e: unknown) =>
          failWith(
            e instanceof Error
              ? e.message
              : 'This device would not save that, so Daak would ask again every launch.',
          ),
      );
    },
    [failWith, onComplete, onReady, state],
  );

  // R42n: pairing a device IS this step's result, so the flow finishes on the
  // engine's own `pairing.done`. Before this the only way out of the step was
  // "Skip for now", so a user who had just paired was asked to skip the step
  // they had completed -- and the scan-then-return-to-onboarding report was the
  // same defect seen from the other end.
  //
  // `pairing.done` and NOT a device count: the count also rises for a peer
  // seen only by mDNS, and a freshly imaged phone must not finish setup on the
  // strength of somebody else's laptop announcing itself.
  useEffect(() => {
    if (step !== 'pair') return;
    return engine.on((e) => {
      if (e.type === 'pairing.done') finish({});
    });
  }, [engine, finish, step]);

  if (step === 'loading') {
    return <View style={ui.screen} testID="onboarding-loading" />;
  }

  if (step === 'fault') {
    return (
      <View style={[ui.screen, { padding: 16 }]} testID="onboarding-fault">
        <Note
          tone="err"
          title="Daak could not read this device"
          body={fault + ' Nothing has been changed. Relaunch the app to try again.'}
        />
      </View>
    );
  }

  if (step === 'done') {
    return null;
  }

  if (step === 'starting') {
    // A blank hold, not a spinner. PairingFlow is reached on this step within a
    // tick or two, and anything rendered here would flash -- but SOMETHING must
    // render, because the previous screen (Permissions) cannot stay mounted
    // while the engine starts or a Continue tap would be live against it.
    // Deliberately label-free: a "Starting..." string on a screen that is
    // invisible for a few frames reads as a hang.
    return <View style={ui.screen} testID="onboarding-starting" />;
  }

  if (step === 'welcome') {
    return (
      <WelcomeScreen
        onGetStarted={() => setStep('name')}
        onSkip={() => {
          // "I already paired this phone" on a fresh install with no record:
          // the user is telling us the questions are answered. Written, not
          // just set in state, or the same two screens appear on every launch.
          //
          // discovery: true, because a phone that answered this was already
          // running Daak and its engine is already starting discovery. Nothing
          // the user is asked here changes that.
          finish({ discovery: true, alerts: granted === true });
        }}
      />
    );
  }

  if (step === 'name') {
    return (
      <NameDeviceScreen
        name={name}
        onNameChange={setName}
        onBack={() => setStep('welcome')}
        footer="Two quick steps left."
        onContinue={() => {
          if (name.trim() === '') return;
          setStep('permissions');
        }}
      />
    );
  }

  if (step === 'permissions') {
    const { stillNeeded } = permissionRows({ notificationsGranted: granted });
    const rows: PermissionRowSpec[] = withNotificationReask(
      { notificationsGranted: granted },
      // Recorded in bootstrap as well as in local state: startup reads the
      // recorded answer and reuses it instead of asking the OS a second time.
      // On Android the second ask is a second system prompt for one decision.
      (answer) => {
        recordNotificationGrant(answer);
        setGranted(answer);
      },
    );
    return (
      <PermissionsScreen
        rows={rows}
        stillNeeded={stillNeeded}
        onBack={() => setStep('name')}
        // R42p: the SAME row Settings renders, on the step that is already "the
        // things Daak needs before it is useful". Both platforms now pick a
        // real folder -- a SAF tree on Android, a document picker in folder mode
        // on iOS -- so this is no longer gated on the platform.
        folder={
          <DownloadFolderRow
            load={downloadFolderName}
            choose={chooseDownloadFolder}
            reset={clearDownloadFolder}
          />
        }
        onContinue={() => {
          void (async () => {
            const next: OnboardingState = {
              complete: false,
              name: name.trim(),
              // Discovery is a fact of the engine's start, not a grant the user
              // made here: there is nothing to switch, so there is nothing to
              // record as declined.
              discovery: true,
              alerts: granted === true,
            };
            if (!(await writeOnboarding(next))) {
              failWith('This device would not save your choices, so they would be lost on the next launch.');
              return;
            }
            setState(next);
            // THE ENGINE MAY NOW START, and the step below WAITS for it to have
            // actually started. The name is durable, which was the one thing
            // that had to be true before any engine published anything -- App
            // starts it and applies this exact name as its first act. Writing
            // before starting means a relaunch never re-asks, even if the
            // engine then refuses the name.
            //
            // 'starting' rather than straight to 'pair': PairingFlow arms a
            // real accept slot through the engine, so rendering it against an
            // engine that has not finished starting is the bug this whole
            // shape exists to remove. The old version moved to 'pair' in the
            // same tick as the onReady() call that only ENABLED App's startup
            // effect -- so the effect ran after this render, and the user could
            // tap "Show QR" against nothing.
            setStep('starting');
            // THE NAME IS PASSED HERE, and this is the only call site that
            // passes one. A first run has no stored name, so the engine came
            // up with the machine default and the user's typed name must be
            // applied explicitly. A relaunch never renders this flow, so it
            // can never replay the keychain copy over a later rename.
            void (onReady?.(name.trim()) ?? Promise.resolve()).then(
              () => setStep('pair'),
              () => setStep('pair'),
            );
          })();
        }}
      />
    );
  }

  return (
    <PairFirstDeviceScreen onBack={() => setStep('permissions')}>
      <View style={ui.stack}>
        {/* The REAL pairing flow, embedded: the engine's own arm, the engine's
            own QR, the engine's own SAS and the real scanner. Nothing here is a
            placeholder, because the prototype's version of this -- a drawn QR,
            a six-digit number picked to look right -- is exactly what must not
            ship. `embedded` drops PairingScreen's own appbar, since this
            screen already draws one. */}
        <PairingFlow embedded />
        <Text style={ui.hint}>
          Pairing is optional. You can skip it and pair later from Devices.
        </Text>
        <Btn
          variant="ghost"
          block
          label="Skip for now"
          testID="pair-skip"
          // The SAME transition as the Welcome skip. The name was already
          // written on the Permissions step, so this carries it forward rather
          // than re-deciding any answer the user gave.
          onPress={() => finish({})}
        />
      </View>
    </PairFirstDeviceScreen>
  );
}
