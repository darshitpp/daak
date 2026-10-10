import React, { useState } from 'react';
import { NameDeviceScreen, PermissionsScreen, SaveLocationScreen, WelcomeScreen, type SaveLocationFolder } from '@daak/ui';
import { desktopPermissionRows, type DesktopCapability } from './onboarding';

/**
 * The prototype's DESKTOP first-run flow: sc-welcome -> sc-name-device ->
 * sc-permissions, from the design file macos.html onwards.
 *
 * WHY THIS IS NOT apps/mobile/src/OnboardingFlow.tsx, which it otherwise
 * mirrors step for step:
 *
 *  - That flow embeds <PairingFlow/>, which arms a pairing slot and renders a QR
 *    scanned by the device CAMERA. macOS has neither: this app registers no
 *    camera module, and the design has no scan step on the desktop. Importing
 *    it would pull TurboModuleRegistry.getEnforcing
 *    calls for modules the macOS host does not register.
 *  - That flow's permissions rows come from @daak/platform's permissionRows,
 *    whose switchable alerts row is backed by initNotifications(), a MOBILE
 *    native module. Here the rows are desktopPermissionRows (see src/onboarding.ts).
 *
 * It still OWNS NO ENGINE. Reaching the end is one durable write followed by a
 * single callback, and index.js is the only place in this app that calls
 * engine.start(). A component that started its own engine would put that
 * ordering rule in two files, which is how the desktop app ended up starting
 * before it had asked anything.
 */

export type DesktopOnboardingStep = 'welcome' | 'name' | 'permissions' | 'save';

export interface CompletedOnboarding {
  name?: string;
  alerts: boolean;
}

export function DesktopOnboardingFlow({
  initialName,
  capabilities,
  downloadFolder,
  onComplete,
}: {
  /** Prefilled from the durable state, if it ever held one. */
  initialName?: string;
  /** What the desktop host can actually report. See desktopPermissionRows. */
  capabilities: DesktopCapability;
  /** The folder verbs. A missing value gives the variant with no folder picker. */
  downloadFolder?: SaveLocationFolder;
  /** Called ONCE, after the durable write has resolved true. Never before. */
  onComplete: (result: CompletedOnboarding) => void;
}) {
  const [step, setStep] = useState<DesktopOnboardingStep>('welcome');
  const [name, setName] = useState(initialName ?? '');
  const [alerts, setAlerts] = useState(capabilities.notifications === true);

  if (step === 'welcome') {
    return (
      <WelcomeScreen onGetStarted={() => setStep('name')} onSkip={() => onComplete({ alerts })} />
    );
  }

  if (step === 'name') {
    return (
      <NameDeviceScreen
        name={name}
        onNameChange={setName}
        onBack={() => setStep('welcome')}
        // One step remains at this commit (alerts), so the design sentence
        // "Three quick steps left." would be false. Task 5 sets the final one.
        footer="Two quick steps left."
        onContinue={() => {
          if (name.trim() === '') return;
          setStep('permissions');
        }}
      />
    );
  }

  if (step === 'permissions') {
    return (
      <PermissionsScreen
        rows={desktopPermissionRows().rows}
        onBack={() => setStep('name')}
        onContinue={() => setStep('save')}
      />
    );
  }

  return (
    <SaveLocationScreen
      folder={downloadFolder ?? { load: async () => null }}
      onBack={() => setStep('permissions')}
      // Pairing stays on the Devices screen on a Mac, so no step remains here.
      footer={null}
      onContinue={() => onComplete({ name: name.trim(), alerts })}
    />
  );
}

