import React, { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import {
  Btn,
  NameDeviceScreen,
  OnboardingScreen,
  SwitchRow,
  WelcomeScreen,
  ui,
  type PermissionRowSpec,
} from '@daak/ui';
import { desktopPermissionRows, type DesktopCapability } from './onboarding';

/**
 * The prototype's DESKTOP first-run flow: sc-welcome -> sc-name-device ->
 * sc-permissions, from app/prototypes/macos.html:605 onwards.
 *
 * WHY THIS IS NOT apps/mobile/src/OnboardingFlow.tsx, which it otherwise
 * mirrors step for step:
 *
 *  - That flow embeds <PairingFlow/>, which arms a pairing slot and renders a QR
 *    scanned by the device CAMERA. macOS has neither: this app registers no
 *    camera module and the prototype's desktop step is "Look around first",
 *    not a scan. Importing it would pull TurboModuleRegistry.getEnforcing
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

export type DesktopOnboardingStep = 'welcome' | 'name' | 'permissions';

/**
 * The desktop prototype's naming step, verbatim (macos.html:626-652).
 *
 * The closing note is omitted because it is the one line that cannot be
 * reused: "Only on your Wi-Fi / People on your network can see this
 * name" is true and also redundant on a Mac, where the user is looking at
 * the machine they are sitting at. The prototype's own desktop step has no
 * such note -- it has the error block and the character hint instead.
 */
const DESKTOP_NAME_COPY = {
  heading: 'Name this Mac',
  lead:
    'This name appears on the other device when it asks to receive a file. Something like a computer name works well.',
  hint: 'A computer name works well, like "Darshit\'s MacBook".',
  error: 'Type something like Darshit\'s MacBook, then move on.',
  note: null,
};

/**
 * The desktop prototype's welcome copy (macos.html:612-624).
 *
 * THIS COPY IS DUPLICATED, NOT IMPORTED, and the duplication is deliberate.
 * @daak/platform exports the same macOS words in MACOS_WELCOME_COPY, but its
 * barrel re-exports every mobile facade, and each of those imports a module
 * that calls TurboModuleRegistry.getEnforcing at module-eval time:
 * DaakBgSched, DaakClipboard, DaakFsPaths, DaakNotify, DaakQrScanner,
 * DaakSecureStore, DaakShare. The macOS host registers none of them, so the
 * import throws while the bundle is still evaluating and the app never
 * renders. This is the same reason this file does not import the mobile
 * PairingFlow, and it is why the words live here instead.
 *
 * The two copies must agree. apps/desktop/test/name-step.spec.ts pins the
 * words this file puts on screen.
 */
const DESKTOP_WELCOME_COPY = {
  eyebrow: 'Welcome',
  heading: 'Send a file to the room next door',
  lead:
    'Photos, videos, documents and text go straight to another device on the same Wi-Fi. Nothing leaves your home network, and no account is needed.',
  // The Mac welcome has no three-things card. Rendering the phone's promises
  // here would put words the reference never shows this surface on a Mac.
  bulletsTitle: null,
  bullets: null,
  note: { title: 'No internet, no sign-up, no waiting.', body: '' },
  skipLabel: 'Look around first',
  // The sidebar already carries the wordmark; the reference notes that putting
  // it in both places showed "Daak" twice in one viewport.
  wordmark: false,
} as const;

export interface CompletedOnboarding {
  name?: string;
  alerts: boolean;
}

export function DesktopOnboardingFlow({
  initialName,
  capabilities,
  onComplete,
}: {
  /** Prefilled from the durable state, if it ever held one. */
  initialName?: string;
  /** What the desktop host can actually report. See desktopPermissionRows. */
  capabilities: DesktopCapability;
  /** Called ONCE, after the durable write has resolved true. Never before. */
  onComplete: (result: CompletedOnboarding) => void;
}) {
  const [step, setStep] = useState<DesktopOnboardingStep>('welcome');
  const [name, setName] = useState(initialName ?? '');
  const [alerts, setAlerts] = useState(capabilities.notifications === true);

  // The prototype's welcome screen is sc-welcome in the mobile shell and the
  // same screen with a Mac sidebar in the desktop shell. The COPY is the
  // desktop one (macos.html:612-624): "Send a file to the room next door" and a
  // "Look around first" exit, because a Mac user is at a keyboard with a Send
  // tab one click away and a phone user is not.
  if (step === 'welcome') {
    return (
      <WelcomeScreen
        onGetStarted={() => setStep('name')}
        onSkip={() => onComplete({ alerts })}
        // The desktop prototype's own words for this step (macos.html:612-624):
        // "Send a file to the room next door", an eyebrow, no three-things
        // card, and a "Look around first" exit, because a Mac user is at a
        // keyboard with a Send tab one click away and a phone user is not.
        copy={DESKTOP_WELCOME_COPY}
      />
    );
  }

  if (step === 'name') {
    return (
      <NameDeviceScreen
        name={name}
        onNameChange={setName}
        onBack={() => setStep('welcome')}
        // The desktop prototype's own words for this step (macos.html:626-652):
        // "Name this Mac", what other devices should call you, and a
        // computer name as the example. The shared component's defaults are
        // the phone's ("Name this device", a Pixel). Layout is shared; the
        // nouns are not, and a Mac is not a phone.
        copy={DESKTOP_NAME_COPY}
        onContinue={() => {
          if (name.trim() === '') return;
          setStep('permissions');
        }}
      />
    );
  }

  const { rows, stillNeeded } = desktopPermissionRows({ notifications: alerts });
  const specs: PermissionRowSpec[] = rows.map((row) => ({
    key: row.key,
    title: row.title,
    sub: row.sub,
    state: row.state,
  }));
  return (
    <DesktopPermissionsStep
      rows={specs}
      stillNeeded={stillNeeded}
      onBack={() => setStep('name')}
      onContinue={() => onComplete({ name: name.trim(), alerts })}
    />
  );
}

/**
 * sc-permissions, with the prototype's own Continue gate.
 *
 * Split out only so the hint string is a named function that a test can read,
 * and so the flow above stays about ORDER. The gate is the prototype's perm-go
 * rule verbatim: Continue is enabled exactly when nothing is still needed.
 *
 * The rows are NOT switchable here, and that is the honest outcome rather than
 * a missing feature: on a Mac, discovery is a side effect of start(), receiving
 * has no preference, and the alert state belongs to the OS. A switch that
 * flips into a state nothing implements is a lie with a control on it. So the
 * Continue gate is real, and it is never actually blocked -- which is exactly
 * what desktopPermissionRows returns `stillNeeded: []` for.
 */
export function DesktopPermissionsStep({
  rows,
  stillNeeded,
  onContinue,
  onBack,
}: {
  rows: PermissionRowSpec[];
  stillNeeded: string[];
  onContinue: () => void;
  onBack?: () => void;
}) {
  const blocked = stillNeeded.length > 0;
  return (
    <OnboardingScreen
      title="Two quick permissions"
      onBack={onBack}
      backLabel="Back to naming this Mac"
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
      <Text style={ui.h1}>Let Daak find nearby devices</Text>
      <Text style={ui.lead}>
        Daak looks for other devices on your Wi-Fi and talks to them directly. It needs these on.
      </Text>

      <View style={ui.card}>
        {rows.map((row) => (
          <SwitchRow
            key={row.key}
            title={row.title}
            sub={row.sub}
            state={row.state}
            testID={'perm-' + row.key}
          />
        ))}
      </View>

      <Text style={ui.hint} testID="permissions-hint">
        {blocked ? 'Still needed: ' + stillNeeded.join(', ') + '.' : 'All set. Daak only looks on this Wi-Fi.'}
      </Text>
    </OnboardingScreen>
  );
}
