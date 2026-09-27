import React, { useEffect } from 'react';
import { SafeAreaView } from 'react-native';
import { AppShell, BackgroundHint, EngineProvider } from '@daak/ui';
import { engine, startEngineOnce } from './bootstrap';
import { PairingFlow } from './PairingFlow';
import { BackgroundSyncNotice } from './BackgroundSyncNotice';

export default function App() {
  // THE engine lifecycle owner, and the first production caller startEngine
  // has ever had (before Task 10 it had none, deliberately: R22 ruled against
  // the plan's version of this effect, which also drained the share inbox).
  //
  // startEngineOnce, not startEngine: this is an idempotent wrapper for the
  // process lifetime, so a StrictMode double-invoke, a Fast Refresh or a
  // remount cannot construct a second engine -- two identities and two
  // discovery stacks on one LAN.
  //
  // It does NOT drain the text/file share inbox. R22 still holds:
  // consumePendingShare is all-or-nothing natively and deletes the metadata
  // naming a staged item, and nothing can route a text/file arm yet (Task 11
  // owns the composer route). bootstrap.ts keeps drainInbound unwired and
  // App.test.tsx pins that this effect did not grow one.
  //
  // A start failure must NOT crash the app: startEngine never rejects on a
  // permission or a scheduling problem (R36, initBackgroundSync), so a throw
  // here is a genuine engine fault -- a rejected keystore identity, an
  // unwritable data directory, a corrupt database. The UI is still worth
  // showing; the ENGINE is dead, and every peer list, every outbox row and
  // every inbound banner is silently absent with nothing on screen to say so.
  //
  // One warn line, because the previous claim that this was reported
  // elsewhere was circular: the banner comes from inbox.received, which can
  // never fire if start() threw. Rendering a real fault banner is Task 11's
  // job and needs a state channel this app does not have; a log line costs
  // nothing and is the difference between a diagnosable field report and a
  // mystery.
  useEffect(() => {
    void startEngineOnce().catch((e: unknown) => {
      console.warn('daak: engine start failed; the app is running with no engine', e);
    });
  }, []);

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <EngineProvider engine={engine}>
        {/* R98: the pair tab is the reachable entry to QR pairing. PairingFlow is
            app-side (R100): the shell stays presentational. */}
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
          background={
            <>
              <BackgroundHint />
              <BackgroundSyncNotice />
            </>
          }
          pair={<PairingFlow />}
        />
      </EngineProvider>
    </SafeAreaView>
  );
}
