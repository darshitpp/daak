import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { requestBatteryExemption } from '@daak/platform';

/**
 * The battery-optimisation affordance. It lives in apps/mobile, not in
 * packages/ui, because it is the only thing permitted to call
 * requestBatteryExemption, and that call reaches a TurboModule via
 * @daak/platform -- which packages/ui deliberately does not depend on.
 *
 * NO useEffect, and that is the whole point of the component. Opening the OS
 * battery allowlist navigates away from the app; firing it on launch would
 * yank the user out of Daak the first time they open it, with no gesture and
 * no explanation. It is a consequence of a tap or it does not happen. Two pins
 * hold that: backgroundExec.test.ts greps this file for `useEffect` with the
 * comments stripped, and backgroundWiring.test.tsx asserts nothing is called
 * before the press.
 *
 * ponytail: one control and one line of advice. If a second OEM-specific
 * prompt is ever needed it is another Pressable here, not a settings screen.
 */
export function BackgroundSyncNotice() {
  return (
    <View>
      <Pressable
        accessibilityLabel="allow-background-sync"
        onPress={() => void requestBatteryExemption()}
      >
        <Text>Allow background sync</Text>
      </Pressable>
      <Text>
        Some phones stop background transfers to save battery. Allow Daak to keep
        sending when the screen is off.
      </Text>
    </View>
  );
}
