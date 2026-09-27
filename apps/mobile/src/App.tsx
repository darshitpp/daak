import React, { useEffect } from 'react';
import { SafeAreaView } from 'react-native';
import { AppShell, EngineProvider } from '@daak/ui';
import { engine, startEngineOnce } from './bootstrap';
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
  // A start failure is swallowed deliberately. startEngine never rejects on a
  // permission or a scheduling problem (R36, initBackgroundSync), so a throw
  // here is a genuine engine fault -- and crashing the whole app over a fault
  // that the notification path already reports as recoverable is the worse
  // answer. The banner for it, if any, comes from the engine itself.
  useEffect(() => {
    void startEngineOnce().catch(() => {});
  }, []);

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <EngineProvider engine={engine}>
        <AppShell background={<BackgroundSyncNotice />} />
      </EngineProvider>
    </SafeAreaView>
  );
}
