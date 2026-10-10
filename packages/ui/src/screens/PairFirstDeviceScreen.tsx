import React from 'react';
import { OnboardingScreen } from '../components/Onboarding';

/**
 * The Pair-first-device step (design route `pair-first-device`) as a frame.
 *
 * The body of the design step is a working QR, a scanner, a 6-digit number, and
 * a Finish button. All of it is driven by the page script, and all of it must be
 * real to mean anything. A QR drawn from no bundle is a code that no device can
 * scan. A number picked to look right is a security check against nothing.
 *
 * So this draws only the step chrome (appbar and back) and hands the flow to the
 * host through `children`. The mobile app passes its real `PairingFlow`. No
 * pairing code is made in `packages/ui`. The lead and the two choices belong to
 * the flow, because the Devices route shows them too.
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
    <OnboardingScreen title="Pair your first device" onBack={onBack} testID="screen-pair-first-device">
      {children}
    </OnboardingScreen>
  );
}

