import React from 'react';
import { View } from 'react-native';
import type { DaakEngine, DeviceInfo } from '@daak/core';
import type { UiState } from '../state/store';
import type { InboxActions } from '../inbox-actions';
import { AppShell } from '../components/AppShell';
import type { DeviceNoun } from '../components/ds';
import type { PhotosHost } from '../components/PhotosAccessRow';
import type { SettingsHost } from '../screens/settings/host';
import type { BatchHost, MediaHost } from '../screens/ThreadScreen';
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
export function Dashboard({ state, engine, peerDeviceId, onPickFiles, inboxActions, pair, alert, alertRouteToken, settingsRouteToken, onCheckConnection, onUnpair, downloadFolder, photos, deviceNoun, windowChrome, keyboardAvoiding, settingsHost, initialFiles, initialShareToken, onShareSend, onCancelShare, onPickFolder, folderStats, discardPickedCopy, pickLabel, media, batch }: {
  state: UiState; engine: DaakEngine; peerDeviceId?: string;
  onPickFiles?: () => Promise<string[]>;
  inboxActions?: InboxActions;
  // The pairing route's content, for the same reason. The shell below is
  // where that route renders it.
  pair?: React.ReactNode | ((onPaired: () => void) => React.ReactNode);
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
    canReset?: (name: string) => boolean;
  };
  photos?: PhotosHost;
  /** "phone" or "Mac" in copy. A prop, because this package has no platform check. */
  deviceNoun?: DeviceNoun;
  /** The Mac window chrome. The sidebar footer reads `version`. */
  windowChrome?: { version?: string };
  /** Lift the composer above the keyboard. The iOS host sets it. */
  keyboardAvoiding?: boolean;
  /** The injected Settings functions: arrival prefs, app version, OS grant. */
  settingsHost?: SettingsHost;
  /** A share from the OS. It routes to Devices, which asks for a device. */
  initialFiles?: string[];
  initialShareToken?: number;
  onShareSend?: (device: DeviceInfo, share: { files: string[]; text?: string }) => Promise<{ cancel: () => Promise<void> } | void>;
  onCancelShare?: () => void;
  /** The phone folder picker. It resolves the path of a copy, or null on Cancel. */
  onPickFolder?: () => Promise<string | null>;
  /** The file count and the size of a folder. Null for a path that is not a folder. */
  folderStats?: (path: string) => Promise<{ files: number; bytes: number } | null>;
  /** Deletes a copy that `onPickFolder` made. */
  discardPickedCopy?: (path: string) => Promise<void>;
  /** The label of the add button when there is no folder menu. macOS sets `Add files or folders`. */
  pickLabel?: string;
  media?: MediaHost;
  /** The state of a large send. Absent when the host has no batch driver. */
  batch?: BatchHost;
}) {
  void state;
  return (
    <EngineProvider engine={engine}>
      <View style={ui.screen}>
        <AppShell
          layout="desktop"
          initialPeerDeviceId={peerDeviceId}
          onPickFiles={onPickFiles}
          onPickFolder={onPickFolder}
          folderStats={folderStats}
          discardPickedCopy={discardPickedCopy}
          pickLabel={pickLabel}
          media={media}
            batch={batch}
          inboxActions={inboxActions}
          pair={pair}
          alert={alert}
          alertRouteToken={alertRouteToken}
          settingsRouteToken={settingsRouteToken}
          onCheckConnection={onCheckConnection}
          onUnpair={onUnpair}
          downloadFolder={downloadFolder}
          photos={photos}
          deviceNoun={deviceNoun}
          windowChrome={windowChrome}
          keyboardAvoiding={keyboardAvoiding}
          settingsHost={settingsHost}
          initialFiles={initialFiles}
          initialShareToken={initialShareToken}
          onShareSend={onShareSend}
          onCancelShare={onCancelShare}
        />
      </View>
    </EngineProvider>
  );
}
