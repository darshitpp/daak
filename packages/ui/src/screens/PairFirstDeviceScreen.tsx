import React from 'react';
import { Text, View } from 'react-native';
import { OnboardingScreen } from '../components/Onboarding';
import { ui } from '../theme';

/**
 * The prototype's screen 4 (sc-pair-first-device) as a FRAME, not a screen.
 *
 * The prototype's body is a working QR display, a scanner viewport, a
 * six-digit verification number, a check row and a Finish button -- all of
 * which are driven by that page's own JavaScript, and all of which would have
 * to be real to mean anything. Fabricating any of it is the one thing this
 * screen must not do: a QR drawn from no bundle is a code no device can scan,
 * and a six-digit number picked to look right is a security check the user
 * performs against nothing. Both would be worse than no screen.
 *
 * So this renders only the prototype's own step chrome -- the appbar, the
 * heading, the lead -- and hands the flow to the app through children. The
 * mobile app passes its REAL PairingFlow (armHostPairing, the engine's own
 * QR, the engine's own SAS). No pairing code is generated in packages/ui.
 */
export function PairFirstDeviceScreen({
  onBack,
  children,
}: {
  onBack?: () => void;
  /** The host's real pairing flow. */
  children: React.ReactNode;
}) {
  return (
    <OnboardingScreen
      title="Step 3 of 3"
      onBack={onBack}
      backLabel="Back to permissions"
      testID="screen-pair-first-device"
    >
      <View style={ui.stack}>
        <Text style={ui.h1}>Pair your first device</Text>
        <Text style={ui.lead}>
          Open Daak on the other device and choose Scan a code. Then check that both screens show the same six numbers.
        </Text>
      </View>
      {children}
    </OnboardingScreen>
  );
}
