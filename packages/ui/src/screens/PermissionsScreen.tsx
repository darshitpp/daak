import React from 'react';
import { Text, View } from 'react-native';
import { Btn } from '../components/ds';
import { OnboardingScreen, SwitchRow, type SwitchState } from '../components/Onboarding';
import { ui } from '../theme';

/**
 * One capability as this build can report it.
 *
 * Omitting `onPress` locks the row. A locked row is the same signal that makes a
 * `SwitchRow` not pressable, so no second flag can disagree with the control.
 * A row in the state `unavailable` is a locked switch: this host cannot read
 * or change the grant. The design off sentence still prints under the row.
 */
export interface PermissionRowSpec {
  /** Stable id, used for the row testID. */
  key: string;
  title: string;
  sub: string;
  state: SwitchState;
  onPress?: () => void;
}

const LEAD = 'Daak finds other devices on your Wi-Fi by itself. Alerts are optional — skip them or turn them on now.';

/**
 * The Permissions step (design route `permissions`, titled "Optional alerts").
 *
 * The design has one row and does not block Continue. The hint under the row
 * states the grant when the host can read it. A host that cannot read the grant
 * (macOS) sets the row to 'unavailable'; the row keeps the design switch and the
 * design off sentence, because the alerts are off and there is nothing to read.
 */
export function PermissionsScreen({
  rows,
  onContinue,
  onBack,
}: {
  rows: PermissionRowSpec[];
  onContinue: () => void;
  onBack?: () => void;
}) {
  const alerts = rows.find((row) => row.key === 'alerts');
  const hint =
    alerts === undefined
      ? null
      : alerts.state === 'on'
        ? 'Alerts are on.'
        : 'Alerts are off. You can continue without them.';
  return (
    <OnboardingScreen
      title="Optional alerts"
      onBack={onBack}
      testID="screen-permissions"
      actions={
        <>
          <Btn variant="primary" block label="Continue" testID="permissions-continue" onPress={onContinue} />
          <Text style={ui.hint}>You can change this later in Settings.</Text>
        </>
      }
    >
      <Text style={ui.lead}>{LEAD}</Text>
      <View style={ui.card}>
        {rows.map((row) => (
          <SwitchRow
            key={row.key}
            title={row.title}
            sub={row.sub}
            state={row.state}
            onPress={row.onPress}
            testID={'perm-' + row.key}
          />
        ))}
      </View>
      {hint === null ? null : (
        <Text style={ui.hint} testID="permissions-hint">
          {hint}
        </Text>
      )}
    </OnboardingScreen>
  );
}

