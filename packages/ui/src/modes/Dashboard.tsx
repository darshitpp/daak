import React from 'react';
import { View } from 'react-native';
import type { DaakEngine, DeviceInfo } from '@daak/core';
import type { UiState } from '../state/store';
import type { InboxActions } from '../inbox-actions';
import { AppShell } from '../components/AppShell';
import type { DeviceNoun } from '../components/ds';
import { EngineProvider } from '../EngineContext';
import { ui } from '../theme';

/**
 * The windowed mode. It reuses the AppShell/TabBar/screens wholesale: those
 * screens own their own engine subscriptions, so the only thing this layer
 * adds is the EngineProvider they read from.
 *
 * The desktop gets the window header, and it gets the SAME route stack every
 * other surface has -- there is no window-only composer and no first-active-
 * transfer shortcut, so one send surface and one transfer list exist.
 *
 * `state` is accepted (the AppShell screens subscribe to the engine directly,
 * so nothing here reads it) only so the host's re-render on store changes still
 * lands. ponytail: drop the prop once nothing reads it.
 */
export function Dashboard({ state, engine, peerDeviceId, onPickFiles, inboxActions, pair, alert, alertRouteToken, settingsRouteToken, onCheckConnection, onUnpair, downloadFolder, deviceNoun, windowChrome, keyboardAvoiding }: {
  state: UiState; engine: DaakEngine; peerDeviceId?: string;
  onPickFiles?: () => Promise<string[]>;
  inboxActions?: InboxActions;
  // The pairing route's content, for the same reason. The shell below is
  // where that route renders it.
  pair?: React.ReactNode;
  /* See DaakUiApp. These four reach AppShell unchanged; this layer only adds
     the EngineProvider the screens read from. */
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
  /** The desktop window header text. */
  windowChrome?: { title: string; version?: string };
  /** Lift the composer above the keyboard. The iOS host sets it. */
  keyboardAvoiding?: boolean;
}) {
  void state;
  return (
    <EngineProvider engine={engine}>
      <View style={ui.screen}>
        <AppShell
          layout="desktop"
          initialPeerDeviceId={peerDeviceId}
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
        />
      </View>
    </EngineProvider>
  );
}
