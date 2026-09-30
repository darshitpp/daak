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
export function Dashboard({ state, engine, peerDeviceId }: { state: UiState; engine: DaakEngine; peerDeviceId?: string }) {
  // R3: ANY known device is composable, and the liveness gate was removed on
  // purpose, not forgotten. Engine::enqueue_outbox_send writes the payload to
  // the outbox DURABLY and only then pokes the peer as an optimisation, so a
  // send to a peer of unknown liveness queues and succeeds -- liveness is not a
  // precondition for sending. The gate also read a field no engine populates
  // on the daemon path (devices() has no `online`; DeviceFound is first-ever
  // only), so on a cold daemon it hid the primary action permanently.
  // ponytail: the first device wins; per-peer SELECTION is Phase 7's business.
  //
  // `peerDeviceId` is the one exception, and it is not a selector: it is a
  // TARGET the host names, arriving from a daak://send?deviceId=... link. It is
  // a prop, not a Platform.OS branch, so this package stays free of platform
  // conditionals and mobile is untouched (mobile routes its own deep links).
  //
  // An override that names no known device yields NO peer, and that is the whole
  // point: the alternative -- falling back to devices[0] -- would point the
  // composer at a machine the link never named, which sends the file to the
  // wrong peer. Showing no composer is a recoverable state; a silent resend to a
  // stranger's laptop is not.
  const peer = peerDeviceId === undefined
    ? state.devices[0]
    : state.devices.find((d) => d.deviceId === peerDeviceId);
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
