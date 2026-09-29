import React from 'react';
import { View } from 'react-native';
import type { DaakEngine } from '@daak/core';
import type { UiState } from '../state/store';
import { AppShell } from '../components/AppShell';
import { ComposerScreen } from '../screens/ComposerScreen';
import { EngineProvider } from '../EngineContext';
import { TransferProgressScreen } from '../screens/TransferProgressScreen';
import { colors } from '../theme';

/**
 * The windowed mode. It reuses the Phase 5 AppShell/TabBar/screens wholesale:
 * those screens own their own engine subscriptions, so the only thing this
 * layer adds is the EngineProvider they read from and the store's transfers
 * (the shell's `transfers` slot, which AppShell has no default for).
 */
export function Dashboard({ state, engine }: { state: UiState; engine: DaakEngine }) {
  // R3: ANY known device is composable, and the liveness gate was removed on
  // purpose, not forgotten. Engine::enqueue_outbox_send writes the payload to
  // the outbox DURABLY and only then pokes the peer as an optimisation, so a
  // send to a peer of unknown liveness queues and succeeds -- liveness is not a
  // precondition for sending. The gate also read a field no engine populates
  // on the daemon path (devices() has no `online`; DeviceFound is first-ever
  // only), so on a cold daemon it hid the primary action permanently.
  // ponytail: the first device wins; per-peer selection is Phase 7's business.
  const peer = state.devices[0];
  // finding 7: only the first active transfer renders. Render a list when two
  // can be active at once.
  const active = state.transfers.find((t) => t.state === 'active');
  return (
    <EngineProvider engine={engine}>
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <AppShell
          transfers={active ? <TransferProgressScreen transferId={active.transferId} /> : null}
          composer={peer ? <ComposerScreen peerDeviceId={peer.deviceId} /> : null}
        />
      </View>
    </EngineProvider>
  );
}
