import React from 'react';
import { Text, View } from 'react-native';
import { Btn } from '../components/ds';
import { OnboardingScreen, SwitchRow, type SwitchState } from '../components/Onboarding';
import { ui } from '../theme';

/**
 * One capability as this build can actually report it.
 *
 * The prototype's screen has three switches and gates Continue on two of
 * them. This app cannot gate on two of them, because it cannot ask for them:
 * there is no JS API that queries or requests iOS local-network permission,
 * and no sound preference anywhere in the codebase. Rendering a switch that
 * flips into a state nothing implements is a lie with a control on it, so this
 * screen renders whatever the host says is true and shows an unavailable row
 * as unavailable.
 */
export interface PermissionRowSpec {
  /** Stable id, used for the row's testID. */
  key: string;
  title: string;
  sub: string;
  state: SwitchState;
  /**
   * Omitted means LOCKED: this build reports the capability but cannot change
   * it from here. That is the same signal that makes a SwitchRow non-
   * pressable, so there is no second flag that could disagree with the
   * control.
   */
  onPress?: () => void;
}

/**
 * The prototype's screen 3 (sc-permissions), with its Continue gate intact.
 *
 * stillNeeded is a list of row TITLES, not a boolean, because the prototype's
 * hint names what is missing ("Still needed: Nearby devices, and Local
 * network") and a hint that cannot name anything is not the same screen. It is
 * empty whenever every row is settled, and Continue is enabled exactly when it
 * is empty -- which is the prototype's own perm-go rule.
 */
export function PermissionsScreen({
  rows,
  stillNeeded,
  onContinue,
  onBack,
}: {
  rows: PermissionRowSpec[];
  /** Titles of the rows that still need the user, in the order given. */
  stillNeeded: string[];
  onContinue: () => void;
  onBack?: () => void;
}) {
  const blocked = stillNeeded.length > 0;
  let hint: string;
  if (stillNeeded.length === 0) {
    hint = 'All set. Daak will only ever look on this Wi-Fi.';
  } else if (stillNeeded.length === 1) {
    hint = 'Still needed: ' + stillNeeded[0] + '.';
  } else {
    hint =
      'Still needed: ' +
      stillNeeded.slice(0, -1).join(', ') +
      ', and ' +
      stillNeeded[stillNeeded.length - 1] +
      '.';
  }
  return (
    <OnboardingScreen
      title="Step 2 of 3"
      onBack={onBack}
      backLabel="Back to naming this device"
      testID="screen-permissions"
      actions={
        <Btn
          variant="primary"
          block
          label="Continue"
          testID="permissions-continue"
          disabled={blocked}
          onPress={onContinue}
        />
      }
    >
      <View style={ui.stack}>
        <Text style={ui.h1}>Two quick permissions</Text>
        <Text style={ui.lead}>
          Daak finds other devices on your Wi-Fi and talks to them directly. It needs these switched on.
        </Text>
      </View>

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

      <Text style={ui.hint} testID="permissions-hint">
        {hint}
      </Text>
    </OnboardingScreen>
  );
}
