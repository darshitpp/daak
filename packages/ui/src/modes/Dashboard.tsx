import React from 'react';
import { View } from 'react-native';
import type { DaakEngine } from '@daak/core';
import type { UiState } from '../state/store';
import type { InboxActions } from '../screens/HistoryScreen';
import { AppShell } from '../components/AppShell';
import { EngineProvider } from '../EngineContext';
import { ui } from '../theme';

/**
 * The windowed mode. It reuses the AppShell/TabBar/screens wholesale: those
 * screens own their own engine subscriptions, so the only thing this layer
 * adds is the EngineProvider they read from.
 *
 * The desktop gets the 248px sidebar, and it gets the SAME Send tab every
 * other surface has -- there is no window-only composer and no first-active-
 * transfer shortcut, so one send surface and one transfer list exist.
 *
 * `state` is accepted (the AppShell screens subscribe to the engine directly,
 * so nothing here reads it) only so the host's re-render on store changes still
 * lands. ponytail: drop the prop once nothing reads it.
 */
export function Dashboard({ state, engine, peerDeviceId, onPickFiles, inboxActions }: {
  state: UiState; engine: DaakEngine; peerDeviceId?: string;
  onPickFiles?: () => Promise<string[]>;
  inboxActions?: InboxActions;
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
        />
      </View>
    </EngineProvider>
  );
}
