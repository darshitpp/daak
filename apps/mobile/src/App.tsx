import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Platform, SafeAreaView, View } from 'react-native';
import {
  AppShell,
  BackgroundHint,
  EngineProvider,
  Note,
  ToastProvider,
  type BlockerHost,
  type IncompatiblePeer,
  type SettingsHost,
  useBlockers,
} from '@daak/ui';
import {
  chooseDownloadFolder,
  clearDownloadFolder,
  downloadFolderName,
  appInfo,
  loadNotifyPrefs,
  readOnboarding,
  saveNotifyPrefs,
} from '@daak/platform';
import {
  drainInbound,
  engine,
  onIncompatiblePeer,
  startEngineOnce,
  wireNotificationActions,
} from './bootstrap';
import { OnboardingFlow } from './OnboardingFlow';
import { PairingFlow } from './PairingFlow';
import { BackgroundSyncNotice } from './BackgroundSyncNotice';
import { pickAttachedFiles } from './SendFlow';
import { mobileInboxActions } from './inbox-actions';
import { onDeepLink, type DeepLink } from './deeplink';
import { peerOfPayload } from './notification-route';

// R44: one bundle ships iOS and Android, and each system decides background
// work through a different mechanism, so the admission sentence differs. The
// choice lives in the host app. packages/ui holds no Platform.OS read.
const backgroundHintBody =
  Platform.OS === 'android'
    ? 'Android decides when background sync runs, through its battery optimisation allowlist.'
    : 'iOS decides when background sync runs.';

// Facts only this host knows. A module constant keeps its identity between
// renders. The Mac host builds the same object with the noun 'Mac'.
const BLOCKER_HOST: BlockerHost = { deviceNoun: 'phone' };

export default function App() {
  // FIRST LAUNCH vs EVERY LAUNCH AFTER. Onboarding owns the engine start on a
  // first launch, because the device name must be persisted before the engine
  // publishes anything and applied the moment the engine is up. So the durable
  // state is read HERE, once, before any engine work is scheduled -- and a
  // read that rejects leaves onboarding in charge rather than silently
  // starting an engine that would re-publish a stale name.
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  // Whether the durable state permits the engine to start. This, and not
  // `onboarded`, is the gate: publishing a name needs a running engine and
  // arming a host pairing needs a running engine, so the flow has to be able to
  // start one while it is still several screens from finished. Gating on
  // `onboarded` is what made the first device a user paired the one device
  // they could not pair.
  // A start failure must be VISIBLE, not only logged: with the engine dead
  // every peer list, outbox row and inbox is silently empty and the banner that
  // used to explain that can never fire (inbox.received needs a running
  // engine). startEngineOnce is idempotent, so a rejected start is permanent
  // for the process -- the note is the honest resting state until a relaunch.
  const [fault, setFault] = useState<string | null>(null);
  // Peers announcing a protocol version this build refuses.
  //
  // The engine SKIPS an incompatible peer rather than listing it, so without
  // this the only symptom of a version mismatch is a network that looks empty
  // -- indistinguishable from "nobody is home".
  const [incompatible, setIncompatible] = useState<IncompatiblePeer[]>([]);
  // daak://send / daak://pair. Held as state and handed to AppShell, which does
  // the routing and the seeding -- the shell already knows the Send screen and
  // the pair slot, so re-implementing either here would be a second route
  // table.
  const [link, setLink] = useState<DeepLink>({ kind: 'none' });
  // R42p: the download folder. VERBS only -- the row owns the state.
  const downloadFolder = {
    load: downloadFolderName,
    choose: chooseDownloadFolder,
    reset: clearDownloadFolder,
  };
  // The Settings inputs that packages/ui may not import. The OS grant is the
  // answer onboarding stored (readOnboarding().alerts). It does not change
  // when the user flips the switch in system settings; see the open question
  // in the P3 plan.
  const settingsHost = useMemo<SettingsHost>(
    () => ({
      // Passed straight through. About reads it in an effect and hides the row
      // when it rejects.
      appInfo,
      notifyPrefs: { load: loadNotifyPrefs, save: saveNotifyPrefs },
      osAlerts: {
        granted: () => readOnboarding().then((s) => s.alerts),
        openSettings: () => {
          void Promise.resolve(Linking.openSettings()).catch(() => {});
        },
      },
    }),
    [],
  );
  // An OS share-sheet import. Held as state and handed to the shell, which
  // SEEDS it into Send -- the same route a daak://send link takes, because
  // from the app's side a shared file and a shared link are one instruction.
  const [shared, setShared] = useState<{ text?: string; files: string[] } | null>(null);
  const [shareFault, setShareFault] = useState('');
  // A tapped [Open] notification. The payload names an InboxRow the Inbox
  // already lists, so the only thing the UI needs is the ROUTE -- a counter,
  // because the same row tapped twice must land on Inbox twice and a payload
  // string would make the second tap a no-op.
  const [inboxRouteToken, setInboxRouteToken] = useState(0);
  const [inboxPeer, setInboxPeer] = useState<string | undefined>(undefined);

  /**
   * THE TWO BLOCKING SCREENS, ONCE, FOR BOTH HOSTS (R43c).
   *
   * This file used to hold its own copy of the update token, the cannot-reach
   * reason, the real outbox rows, the reachability check and the alert node.
   * apps/desktop/src/shells.tsx had none of it, so the two hosts could not
   * agree about when the screen opens, and one of them could not open it at
   * all. useBlockers is now the single implementation, and this host forwards
   * its four values unchanged.
   *
   * The hook takes the ALREADY REDUCED list rather than subscribing to the
   * engine itself, so `incompatible` above stays the phone's ONE subscription
   * (R43a). The hook never subscribes, so a second engine.on cannot double an
   * event here either.
   *
   * packages/ui gains no platform code from this: the hook's only engine calls
   * are devices() and listTransfers(), which every DaakEngine already carries.
   */
  const blockers = useBlockers(engine, incompatible, BLOCKER_HOST);

  /**
   * THE engine start, memoized for the lifetime of the component and called
   * from two places: the mount effect for a returning user, and
   * readyForPairing below for a first launch. Both wait on the SAME promise, so
   * whichever arrives first does the work -- there is no second engine and no
   * ordering question left to get wrong.
   *
   * It never rejects. Every caller wants to continue either way: the shell
   * renders a fault note, and the onboarding flow falls through to its skip
   * button rather than hanging on a start that will never succeed.
   */
  const bootRef = useRef<Promise<void> | undefined>(undefined);
  const boot = useCallback((): Promise<void> => {
    // LAZY, not useMemo: a memo factory runs during RENDER, and rendering App
    // is the first thing that happens on a first launch -- so a useMemo here
    // would start the engine and publish an engine-generated device name before
    // the user had chosen one, which is the exact thing the name screen exists
    // to prevent. The ref memoizes on first CALL instead, and the first call is
    // only ever made once the durable state permits a start.
    bootRef.current ??= startEngineOnce().then(
      // NO NAME IS APPLIED HERE. The engine reads its display name back out
      // of SQLite during start, and that file is the source of truth. This
      // chain used to call applyPersistedName, which re-read the KEYCHAIN copy
      // of the name and wrote it over whatever the user last typed in
      // Settings -- so a rename reverted on every relaunch, and a name the
      // user had deliberately replaced was resurrected each time the app came
      // back. The keychain keeps its completion flags and its permission
      // choices; it is no longer an authority on the name.
      () => undefined,
      (e: unknown) => {
        console.warn('daak: engine start failed; the app is running with no engine', e);
        setFault(e instanceof Error ? e.message : String(e));
      },
    );
    return bootRef.current;
  }, [startEngineOnce]);

  /**
   * OnboardingFlow's onReady: starts the engine, applies the name the FIRST
   * RUN just chose, and RESOLVES once it is
   * usable, which is what makes the pairing step safe to render.
   *
   * This is the fix for a race a boolean could not express. The previous
   * version set `ready`, `ready` enabled a startup effect, and that effect ran
   * AFTER the render which had already moved the flow on to Pair -- so Pair
   * rendered while the engine was still starting, and arming a host accept
   * slot against a dead engine is exactly why the very first device a user
   * paired was the one device they could not pair.
   *
   * An awaited promise is the only shape that survives React's effect
   * scheduling: readiness becomes something the flow can WAIT for, rather than
   * a flag it can only observe being set.
   */
  const readyForPairing = useCallback(
    (/** @type {string | undefined} */ chosenName?: string): Promise<void> =>
      boot().then(async () => {
        // FIRST RUN ONLY, and only for a name the user actually typed. This is
        // the one place a name must still be applied by hand: there is no
        // stored name yet on a first launch, so the engine started with the
        // machine default and the user must be able to replace it.
        //
        // A RELAUNCH never comes through here, which is the R42 point. This
        // function belongs to OnboardingFlow, and OnboardingFlow renders only
        // while `onboarded !== true`, so a returning user cannot reach it and
        // cannot have the keychain copy replayed over their Settings rename.
        if (chosenName === undefined || chosenName.trim() === '') return;
        try {
          await engine.setDisplayName(chosenName.trim());
        } catch (e) {
          // The name stays unapplied and Daak keeps the engine default. That is
          // a cosmetic failure and not a lost one: the choice is still in the
          // keychain and Settings can apply it again, so this warns and lets the
          // shell render rather than blocking the whole app on it.
          console.warn('daak: could not apply the chosen device name:', e);
        }
      }),
    [boot],
  );

  // THE engine lifecycle owner, and the first production caller startEngine
  // has ever had (before Task 10 it had none, deliberately: R22 ruled against
  // the plan's version of this effect, which also drained the share inbox).
  //
  // startEngineOnce, not startEngine: this is an idempotent wrapper for the
  // process lifetime, so a StrictMode double-invoke, a Fast Refresh or a
  // remount cannot construct a second engine -- two identities and two
  // discovery stacks on one LAN.
  //
  // The share drain is chained onto THIS call, not a second effect:
  // consumePendingShare is all-or-nothing natively and deletes the metadata
  // naming a staged item, so it has to be in the composer in the same tick.
  //
  // A start failure must NOT crash the app: startEngine never rejects on a
  // permission or a scheduling problem (R36, initBackgroundSync), so a throw
  // here is a genuine engine fault -- a rejected keystore identity, an
  // unwritable data directory, a corrupt database. The UI is still worth
  // showing; the ENGINE is dead, and every peer list, every outbox row and
  // every inbound banner is silently absent with nothing on screen to say so.
  //
  useEffect(() => {
    let cancelled = false;
    void readOnboarding().then(
      (stored) => {
        if (cancelled) return;
        setOnboarded(stored.complete);
        // A returning user is done, so the engine may start. A FIRST launch is
        // not ready merely because a read resolved -- it waits for
        // OnboardingFlow's onReady, which fires only once an answer has been
        // durably written. Permitting a start here instead would publish an
        // engine-generated device name to every peer before the user chose one,
        // which is the entire thing these screens exist to prevent.
        if (stored.complete) void boot();
      },
      () => {
        // A keystore that cannot be read is OnboardingFlow's problem to
        // report, not a reason to start an engine behind the user's back.
        if (!cancelled) setOnboarded(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // No share drain until the engine is up. A first launch that published an
    // engine-backed name nobody chose would show a machine-generated device
    // name in every peer list, which is the whole point of the name screen.
    if (onboarded !== true) return undefined;
    let cancelled = false;
    // ONE boot, memoized, awaited here and by readyForPairing below. Whichever
    // caller arrives first does the work and the other waits on the SAME
    // promise, so there is no second engine and no ordering question left to
    // get wrong.
    void boot().then(() => {
      if (cancelled) return;
      return drainInbound((items) => {
        if (cancelled) return;
        // intent-send is bootstrap's: it names its own destination and was
        // already sent from a separate, non-destructive subdir.
        // Re-importing it here would draft a note the user never typed.
        const text = items.find((i) => i.kind === 'text');
        const files = items.filter((i) => i.kind === 'file').map((i) => i.path);
        if (files.length === 0 && text === undefined) return;
        setShared({
          text: text?.kind === 'text' ? text.text : undefined,
          files,
        });
      }).catch((e: unknown) => {
        // Only reachable when the START succeeded: a rejected start is already
        // the engine fault note, and this would double-report it.
        if (!cancelled) setShareFault(e instanceof Error ? e.message : String(e));
      });
    });
    return () => {
      cancelled = true;
    };
  }, [boot, onboarded]);

  // Both sources, because both are needed: getInitialURL is the cold launch
  // with no event after it, and the 'url' event is a link into a running app.
  // No drain, no mount-time engine work -- a link only routes and prefills.
  useEffect(() => onDeepLink(setLink), []);

  // peer.incompatible, off the ONE engine subscription in bootstrap. A peer is
  // added by id and never removed: the engine sends no "it stopped announcing"
  // event, and inventing one would be guessing. The list is re-read from the
  // real device list instead -- a peer that has genuinely left is not in it.
  //
  // This is the REDUCED list and nothing more. Deciding which of these peers
  // opens Update Required belongs to useBlockers, which reads this value rather
  // than opening a subscription of its own, so a second engine.on cannot
  // double an event (R43a).
  useEffect(
    () =>
      onIncompatiblePeer((peer) => {
        // Re-announcing replaces rather than appends, so one out-of-step peer
        // occupies one row no matter how often it announces itself.
        setIncompatible((current) => [
          peer,
          ...current.filter((p) => p.peerDeviceId !== peer.peerDeviceId),
        ]);
      }),
    [],
  );

  // The tapped-notification handlers, wired ONCE for the process. This was
  // the last production path with no call site: [Open] and [Share] were
  // installed by initNotifications and had nothing behind them, so a tap was
  // silently dropped. `reveal` is mobileInboxActions.open because daak.folder
  // is withheld from the installed category on both platforms (R37/R41), so
  // this handler is unreachable -- and it stays the real reveal rather than a
  // no-op, so nothing has to change when iOS grows one.
  useEffect(
    () =>
      wireNotificationActions(
        (path) => void mobileInboxActions.open?.(path),
        (payload) => {
          setInboxPeer(peerOfPayload(payload));
          setInboxRouteToken((n) => n + 1);
        },
      ),
    [],
  );

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <EngineProvider engine={engine}>
        <ToastProvider>
        {fault === null ? null : (
          <View style={{ padding: 16, paddingBottom: 0 }}>
            <Note
              tone="err"
              title="Daak's engine did not start"
              body={`Nothing can be sent or received until this is fixed: ${fault}`}
            />
          </View>
        )}
        {shareFault === '' ? null : (
          <View style={{ padding: 16, paddingBottom: 0 }}>
            <Note
              tone="err"
              title="A shared item did not arrive"
              body={`Daak could not read what the other app shared: ${shareFault}`}
            />
          </View>
        )}
        {/* Onboarding renders INSTEAD of the shell until the flow finishes.
            It owns NO engine: onComplete fires only after the durable write has
            landed, which flips `onboarded`, and the effect above does the one
            start. Two files each holding an engine start is how the flow once
            reached Pair with nothing running and could not arm a host. */}
        {onboarded === true ? null : (
          <OnboardingFlow
            onReady={readyForPairing}
            onComplete={() => setOnboarded(true)}
          />
        )}
        {/* R98: pairing is reachable from Devices, not from a sixth tab. PairingFlow
            is app-side (R100): the shell stays presentational. */}
        {/* BackgroundHint JOINS BackgroundSyncNotice rather than replacing it.
            Same slot, two audiences: the notice is the action (allow
            background sync), the hint is the sentence that says which system
            decides when background work runs. That sentence differs per
            platform, so it is chosen HERE, in the app layer, and passed in as
            `body`; packages/ui keeps its default platform-neutral and has no
            platform conditional (R44). The old fixed sentence named iOS and
            was a falsehood on Android.
            No onOpen is passed: engine.backgroundWake() does not exist until
            Phase 7 Task 3 (R61), and a Pressable wired to nothing is a dead
            button (R128). No AppState listener for the same reason -- the
            outbox ticker already drains on reconnect, so there is nothing a
            foreground wake would add (GAP 1). */}
        {onboarded === true ? (
        <AppShell
          layout="mobile"
          background={
            <>
              <BackgroundHint body={backgroundHintBody} />
              <BackgroundSyncNotice />
            </>
          }
          pair={
            <PairingFlow
              bundle={link.kind === 'pair' ? link.bundle : undefined}
              addr={link.kind === 'pair' ? link.addr : undefined}
            />
          }
          // pickAttachedFiles is the real picker: iOS a
          // UIDocumentPickerViewController (asCopy: true), Android
          // ACTION_OPEN_DOCUMENT. It is INJECTED rather than called inside
          // packages/ui, which takes no @daak/platform dependency and no
          // TurboModule.
          onPickFiles={pickAttachedFiles}
          inboxActions={mobileInboxActions}
          // The prototype's "...isn't showing? See what to check" affordances,
          // on the Devices tab and in Settings. This is the ONLY thing that
          // opens the can't-reach screen, and it is the hook's own function, so
          // the phone and the desktop cannot disagree about when it opens (R43b).
          onCheckConnection={blockers.onCheckConnection}
          downloadFolder={downloadFolder}
          initialPeerDeviceId={link.kind === 'send' ? link.deviceId : undefined}
          // ?? '' and not `link.text`: a send link with NO text is an
          // instruction to send nothing, and undefined here would leave the
          // note the user typed for the previous target in the box -- attached
          // to the files on a peer their own tap never chose.
          initialText={
            link.kind === 'send' ? link.text ?? '' : shared?.text
          }
          initialFiles={shared?.files}
          pairBundle={link.kind === 'pair' ? link.bundle : undefined}
          // The prototype's two blocking screens, shown ONLY for a real
          // condition the engine or a real engine.devices() call produced.
          // There is no path that renders either without one, because `alert`
          // is undefined whenever no peer is out of step and devices() has not
          // come back empty. All three values come from useBlockers, which is
          // the one implementation both hosts share (R43c).
          alert={blockers.alert}
          alertRouteToken={blockers.alertRouteToken}
          settingsRouteToken={blockers.settingsRouteToken}
          inboxRouteToken={inboxRouteToken === 0 ? undefined : String(inboxRouteToken)}
          inboxPeerDeviceId={inboxPeer}
          deviceNoun="phone"
          keyboardAvoiding={Platform.OS === 'ios'}
          settingsHost={settingsHost}
        />
        ) : null}
        </ToastProvider>
      </EngineProvider>
    </SafeAreaView>
  );
}
