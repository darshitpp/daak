import React from 'react';
import { Pressable, Text, View } from 'react-native';
import type { TransferRow, UiState } from '../state/store';
import { DeviceCard } from '../components/DeviceCard';
import { ProgressRow } from '../components/ProgressRow';
import { colors, spacing, type } from '../theme';

/**
 * Menu-bar popover. Presentational only: state arrives already folded, and
 * `onExpand` is the single thing it can do. `onExpand` opens the dashboard
 * WINDOW, which is the host shell's business -- the engine has no such verb, so
 * this must never be wired to engine.start().
 *
 * NO per-device Send button here, unlike the plan: it would have to call
 * engine.send({ files: [] }) and the engine refuses an empty send
 * (InProcess.ts "refusing an empty send"), so that button is a dead control
 * that throws. Sending is the dashboard's composer.
 * ponytail: add a send affordance when the popover has somewhere to compose.
 */
export function Popover({ state, onExpand }: {
  state: UiState;
  onExpand: () => void;
}) {
  const devices = state.devices.slice(0, 3);
  const transfer = state.transfers.find((t: TransferRow) => t.state === 'active');
  return (
    <View style={{ width: 320, padding: spacing.md, gap: spacing.sm, backgroundColor: colors.bg }}>
      <Text style={{ color: colors.text, fontSize: type.title }}>Daak</Text>
      {/* ponytail: DeviceCard prints device.online ? 'online' : 'offline', so a
          primed cold-daemon peer (online undefined) reads 'offline' -- a
          reachability claim the engine never makes, since a send to it queues
          anyway. The real fix is three-state liveness in the shared DeviceCard,
          which mobile also uses; carried to Phase 7. */}
      {devices.map((d) => (
        <DeviceCard key={d.deviceId} device={d} />
      ))}
      {devices.length === 0 ? (
        <Text style={{ color: colors.dim, fontSize: type.dim }}>No devices nearby.</Text>
      ) : null}
      {transfer ? (
        <ProgressRow name={transfer.transferId} bytesDone={transfer.bytesDone}
          bytesTotal={transfer.bytesTotal} state={transfer.state} />
      ) : null}
      <Pressable accessibilityLabel="open-dashboard" onPress={onExpand}>
        <Text style={{ color: colors.accent, fontSize: type.body }}>Open Dashboard</Text>
      </Pressable>
    </View>
  );
}
