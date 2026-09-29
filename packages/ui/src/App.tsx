import React, { useCallback, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import type { DaakEngine } from '@daak/core';
import type { AppMode, UiRuntime } from './headless';
import { Popover } from './modes/Popover';
import { Dashboard } from './modes/Dashboard';

/**
 * `onExpand` is threaded from the host shell, which is the only thing that can
 * open the dashboard window. The default is a no-op, not engine.start():
 * start() boots the engine, it does not show a window.
 */
export function DaakUiApp({ mode, engine, runtime, onExpand = () => {} }: {
  mode: AppMode;
  engine: DaakEngine;
  runtime: UiRuntime;
  onExpand?: () => void;
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
        ? <Popover state={state} onExpand={onExpand} />
        : <Dashboard state={state} engine={engine} />}
    </View>
  );
}
