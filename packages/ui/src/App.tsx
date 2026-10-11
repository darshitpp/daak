import React, { useCallback, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import type { DaakEngine, DeviceInfo } from '@daak/core';
import type { AppMode, UiRuntime } from './headless';
import type { InboxActions } from './inbox-actions';
import { ToastProvider } from './components/Toast';
import type { DeviceNoun } from './components/ds';
import type { SettingsHost } from './screens/settings/host';
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
 * INJECTED (see ThreadScreen), and DaakUiApp is where the desktop shell hands
 * its NSOpenPanel-backed picker down. The POPOVER also has a real send now
 * (prototype: pick a device, pick a file, send), so it takes the same picker and
 * the same engine rather than rendering a Send button wired to nothing.
 */
export function DaakUiApp({ mode, engine, runtime, onExpand = () => {}, peerDeviceId, onPickFiles, inboxActions, pair, alert, alertRouteToken, settingsRouteToken, onCheckConnection, onUnpair, downloadFolder, deviceNoun, windowChrome, keyboardAvoiding, toastBottomOffset, toastLayout, settingsHost }: {
  mode: AppMode;
  engine: DaakEngine;
  runtime: UiRuntime;
  onExpand?: () => void;
  peerDeviceId?: string;
  onPickFiles?: () => Promise<string[]>;
  inboxActions?: InboxActions;
  /**
   * The pairing route's content. A SLOT for the reason AppShell documents
   * one: the facts live on the host, which owns the engine and the platform
   * pairing modules. Mobile passes its PairingFlow; the desktop passes its own
   * host-half component. A host that passes none renders no pair route and
   * draws no "Pair a device" button -- which is what the desktop shipped, and
   * the reason it could not pair and so could not send.
   */
  pair?: React.ReactNode;
  /* The two BLOCKING screens, plus the tokens that route to them. They are
     threaded rather than built here for the reason `pair` is a slot in
     AppShell: the facts live on the host, which owns the engine, and
     packages/ui takes no engine. The desktop shell was the one host that
     passed none of these, so the macOS prototype lost `Can't Reach` and
     `Update Required` while iOS and Android kept them. */
  alert?: React.ReactNode;
  alertRouteToken?: string;
  settingsRouteToken?: string;
  onCheckConnection?: () => void;
  onUnpair?: (d: DeviceInfo) => void;
  downloadFolder?: {
    load: () => Promise<string | null>;
    choose: () => Promise<string | null>;
    reset?: () => Promise<void>;
  };
  /** "phone" or "Mac" in copy. A prop, because this package has no platform check. */
  deviceNoun?: DeviceNoun;
  /** The Mac window chrome. The sidebar footer reads `version`. */
  windowChrome?: { version?: string };
  /** Lift the composer above the keyboard. The iOS host sets it. */
  keyboardAvoiding?: boolean;
  /** The Mac design puts the toast nearer the bottom edge than the phone design does. */
  toastBottomOffset?: number;
  /** The Mac design shows a pill. The phone design shows a full-width bar. */
  toastLayout?: 'bar' | 'pill';
  /** The injected Settings functions: arrival prefs, app version, OS grant. */
  settingsHost?: SettingsHost;
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
    <ToastProvider bottomOffset={toastBottomOffset} layout={toastLayout}>
    <View style={{ flex: 1 }}>
      {mode === 'popover'
        ? <Popover
            state={state}
            engine={engine}
            onExpand={onExpand}
            onPickFiles={onPickFiles}
            alert={alert}
            alertRouteToken={alertRouteToken}
            deviceNoun={deviceNoun}
          />
        : <Dashboard
            state={state}
            engine={engine}
            peerDeviceId={peerDeviceId}
            onPickFiles={onPickFiles}
            inboxActions={inboxActions}
            pair={pair}
            alert={alert}
            alertRouteToken={alertRouteToken}
            settingsRouteToken={settingsRouteToken}
            onCheckConnection={onCheckConnection}
            onUnpair={onUnpair}
            downloadFolder={downloadFolder}
            deviceNoun={deviceNoun}
            windowChrome={windowChrome}
            keyboardAvoiding={keyboardAvoiding}
            settingsHost={settingsHost}
          />}
    </View>
    </ToastProvider>
  );
}
