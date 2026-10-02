import React, { useCallback, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import type { DaakEngine } from '@daak/core';
import type { AppMode, UiRuntime } from './headless';
import type { InboxActions } from './screens/HistoryScreen';
import { Popover } from './modes/Popover';
import { Dashboard } from './modes/Dashboard';

/**
 * `onExpand` is threaded from the host shell, which is the only thing that can
 * open the dashboard window. The default is a no-op, not engine.start():
 * start() boots the engine, it does not show a window.
 *
 * `peerDeviceId` overrides which device the composer points at. The host sets
 * it from a daak://send?deviceId=... link; leaving it undefined keeps the
 * devices[0] default, which is what every host that has no such link wants.
 * Optional prop, not a platform check, so mobile compiles and behaves exactly
 * as it did.
 *
 * `onPickFiles` is threaded for the same reason: the composer's file picker is
 * INJECTED (see ComposerScreen), and DaakUiApp is where the desktop shell hands
 * its NSOpenPanel-backed picker down. The POPOVER also has a real send now
 * (prototype: pick a device, pick a file, send), so it takes the same picker and
 * the same engine rather than rendering a Send button wired to nothing.
 */
export function DaakUiApp({ mode, engine, runtime, onExpand = () => {}, peerDeviceId, onPickFiles, inboxActions }: {
  mode: AppMode;
  engine: DaakEngine;
  runtime: UiRuntime;
  onExpand?: () => void;
  peerDeviceId?: string;
  onPickFiles?: () => Promise<string[]>;
  inboxActions?: InboxActions;
}) {
  // Keyed on [runtime]: an inline arrow is a new function every render, so
  // useSyncExternalStore resubscribes on every event it just delivered.
  const subscribe = useCallback(
    (onChange: () => void) => runtime.subscribe(onChange),
    [runtime],
  );
  const state = useSyncExternalStore(
    subscribe,
    () => runtime.getState(),
  );
  return (
    <View style={{ flex: 1 }}>
      {mode === 'popover'
        ? <Popover state={state} engine={engine} onExpand={onExpand} onPickFiles={onPickFiles} />
        : <Dashboard state={state} engine={engine} peerDeviceId={peerDeviceId} onPickFiles={onPickFiles} inboxActions={inboxActions} />}
    </View>
  );
}
