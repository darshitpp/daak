import React, { useEffect, useState } from 'react';
import { SafeAreaView, View } from 'react-native';
import { AppShell, BackgroundHint, EngineProvider, Note } from '@daak/ui';
import { drainInbound, engine, startEngineOnce } from './bootstrap';
import { PairingFlow } from './PairingFlow';
import { BackgroundSyncNotice } from './BackgroundSyncNotice';
import { pickAttachedFiles } from './SendFlow';
import { mobileInboxActions } from './inbox-actions';
import { onDeepLink, type DeepLink } from './deeplink';

export default function App() {
  // A start failure must be VISIBLE, not only logged: with the engine dead
  // every peer list, outbox row and inbox is silently empty and the banner that
  // used to explain that can never fire (inbox.received needs a running
  // engine). startEngineOnce is idempotent, so a rejected start is permanent
  // for the process -- the note is the honest resting state until a relaunch.
  const [fault, setFault] = useState<string | null>(null);
  // daak://send / daak://pair. Held as state and handed to AppShell, which does
  // the routing and the seeding -- the shell already knows the Send screen and
  // the pair slot, so re-implementing either here would be a second route
  // table.
  const [link, setLink] = useState<DeepLink>({ kind: 'none' });
  // An OS share-sheet import. Held as state and handed to the shell, which
  // SEEDS it into Send -- the same route a daak://send link takes, because
  // from the app's side a shared file and a shared link are one instruction.
  const [shared, setShared] = useState<{ text?: string; files: string[] } | null>(null);
  const [shareFault, setShareFault] = useState('');
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
    // One effect, TWO jobs, because the drain must not run before the engine
    // is up and startEngineOnce must be called exactly once: two effects
    // calling it is two calls, and the wrapper exists so a remount or a Fast
    // Refresh cannot start a second engine.
    //
    // The drain is all-or-nothing natively -- the batch metadata naming these
    // bytes is deleted as it is handed back -- so a drained item MUST be in the
    // composer in this same tick or it is unreferenced. It is seeded, not sent:
    // the user still picks a device and taps Send.
    void startEngineOnce().then(
      () =>
        drainInbound((items) => {
          if (cancelled) return;
          // intent-send is bootstrap's: it names its own destination and was
          // already sent from a separate, non-destructive subdir. Re-importing
          // it here would draft a note the user never typed.
          const text = items.find((i) => i.kind === 'text');
          const files = items.filter((i) => i.kind === 'file').map((i) => i.path);
          if (files.length === 0 && text === undefined) return;
          setShared({
            text: text?.kind === 'text' ? text.text : undefined,
            files,
          });
        }).catch((e: unknown) => {
          // Only reachable when the START succeeded: a rejected start is
          // reported by the fault note below, and this would double-report it.
          if (!cancelled) setShareFault(e instanceof Error ? e.message : String(e));
        }),
      (e: unknown) => {
        console.warn('daak: engine start failed; the app is running with no engine', e);
        if (!cancelled) setFault(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [startEngineOnce]);

  // Both sources, because both are needed: getInitialURL is the cold launch
  // with no event after it, and the 'url' event is a link into a running app.
  // No drain, no mount-time engine work -- a link only routes and prefills.
  useEffect(() => onDeepLink(setLink), []);

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <EngineProvider engine={engine}>
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
        {/* R98: pairing is reachable from Devices, not from a sixth tab. PairingFlow
            is app-side (R100): the shell stays presentational. */}
        {/* BackgroundHint JOINS BackgroundSyncNotice rather than replacing it.
            Same slot, same truth told twice by two audiences: the notice is the
            Android-shaped action (allow background sync), the hint is the
            iOS-shaped admission (iOS decides when it runs). One of the two is
            always a no-op on the other platform, and both are honest about it.
            No onOpen is passed: engine.backgroundWake() does not exist until
            Phase 7 Task 3 (R61), and a Pressable wired to nothing is a dead
            button (R128). No AppState listener for the same reason -- the
            outbox ticker already drains on reconnect, so there is nothing a
            foreground wake would add (GAP 1). */}
        <AppShell
          layout="mobile"
          background={
            <>
              <BackgroundHint />
              <BackgroundSyncNotice />
            </>
          }
          pair={<PairingFlow bundle={link.kind === 'pair' ? link.bundle : undefined} />}
          // pickAttachedFiles is the real picker: iOS a
          // UIDocumentPickerViewController (asCopy: true), Android
          // ACTION_OPEN_DOCUMENT. It is INJECTED rather than called inside
          // packages/ui, which takes no @daak/platform dependency and no
          // TurboModule.
          onPickFiles={pickAttachedFiles}
          inboxActions={mobileInboxActions}
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
        />
      </EngineProvider>
    </SafeAreaView>
  );
}
