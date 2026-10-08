/**
 * What the Permissions screen is allowed to claim, derived from what this build
 * can actually do.
 *
 * THE RULE: a switch rendered ON is a promise the capability is granted, and a
 * switch rendered OFF with a live onPress is a promise that tapping it changes
 * something. Both are decided here, against the real platform surface, rather
 * than assumed by the screen.
 *
 * What exists today:
 *
  - NOTIFICATIONS. Real. notify.ts calls NativeDaakNotify.requestPermission(),
 *    which is UNAUserNotificationCenter on iOS and a real runtime
 *    POST_NOTIFICATIONS ask on Android. The row is genuinely switchable and the
 *    state is a real OS answer.
 *
  - DISCOVERY. Real, but NOT switchable from JS. Neither platform exposes a
 *    JavaScript API that queries or requests local-network permission: iOS gates
 *    it behind an OS prompt triggered by the first mDNS browse
 *    (NSLocalNetworkUsageDescription + NSBonjourServices in Info.plist), and
 *    Android has no runtime local-network permission at all. The engine begins
 *    discovery inside engine.start() and DaakEngine has no stopDiscovery, so
 *    there is nothing to call. Reported, never toggled.
 *
 *  - SOUND. There is NO sound preference anywhere in this codebase -- not in the
 *    engine, not in a TurboModule, not in the onboarding state. The prototype
 *    titles its third switch "Sound when a file arrives". That title is the
 *    second half of a lie this build refuses to tell: what initNotifications
 *    actually returns is whether the OS will post an arrival BANNER, and it
 *    says nothing about how loud it is. So the row is titled for what the real
 *    API answers.
 *
 * This is a local type rather than an import from @daak/ui because @daak/ui
 * depends on @daak/core and nothing else; the reverse is the inversion that has
 * been avoided throughout (see SettingsScreen's comment on the background
 * slot). The shape is structurally identical to ui's PermissionRowSpec, so the
 * screen accepts these rows directly.
 */
import { initNotifications } from './notify';

export type PermissionSwitchState = 'on' | 'off' | 'unavailable';

export interface PermissionRow {
  key: string;
  title: string;
  sub: string;
  state: PermissionSwitchState;
  /** Omitted means locked: reported, but nothing on this screen can change it. */
  onPress?: () => void;
}

export const DISCOVERY_TITLE = 'Nearby devices';
export const NETWORK_TITLE = 'Local network';
/**
 * NOT "Sound when a file arrives", which is the prototype's title. There is no
 * sound preference to grant anywhere in this codebase, and naming one here
 * would claim a control that changes a setting Daak does not have.
 */
export const ALERTS_TITLE = 'Alerts when a file arrives';

export interface CapabilityFacts {
  /**
   * The REAL initNotifications() result: whether the OS will let Daak post an
   * arrival banner. undefined means it has not been asked yet, which is the
   * first-launch state and is NOT the same as denied.
   */
  notificationsGranted?: boolean;
}

export function permissionRows(facts: CapabilityFacts): {
  rows: PermissionRow[];
  stillNeeded: string[];
} {
  const granted = facts.notificationsGranted;
  const rows: PermissionRow[] = [
    {
      key: 'nearby',
      title: DISCOVERY_TITLE,
      sub: 'Daak looks for other Daak devices on this Wi-Fi as soon as it starts. Daak cannot turn this off.',
      // Discovery is on from the first launch and cannot be switched off from
      // here, because the engine owns it and there is no API to stop it. The
      // row therefore states a fact rather than offering a control that lies,
      // and says so in the subtitle rather than leaving the user to guess why
      // this one has no switch.
      state: 'unavailable',
    },
    {
      key: 'network',
      title: NETWORK_TITLE,
      sub:
        'Lets Daak pass files to the other device, without going through the internet. iOS may ask for this itself; Daak cannot check the answer.',
      // Same reasoning, and this is the one that varies by OS: iOS may show a
      // local-network prompt at any moment and Android never will. Neither is
      // queryable from JS, so rendering this ON would claim a grant that a user
      // may have refused in the system prompt an hour ago. UNAVAILABLE is the
      // honest rendering of "reported, and changeable only in Settings".
      state: 'unavailable',
    },
    {
      key: 'alerts',
      title: ALERTS_TITLE,
      sub:
        granted === undefined
          ? 'Optional. A short banner so you know something came in.'
          : granted
            ? 'Daak will show a banner when a file arrives.'
            : 'Turned off, so nothing will pop up. Files still arrive either way.',
      state: granted === true ? 'on' : 'off',
    },
  ];
  return {
    rows,
    // NOTHING blocks Continue.
    //
    // The other two rows are facts the user cannot change here, and the alerts
    // row is OPTIONAL -- its own subtitle says so. Gating on it dead-ended
    // onboarding on iOS, which never re-prompts after a denial: a user who
    // tapped "Don't Allow" could never leave this step, because the Continue
    // button was disabled by a permission the same screen calls optional.
    // Declining a banner costs a banner and never a transfer (R36), so the step
    // may offer the row without requiring an answer.
    stillNeeded: [],
  };
}

/**
 * The same rows with a REAL re-ask bound to the alerts row.
 *
 * initNotifications() is idempotent by platform: iOS will not show the system
 * prompt twice for the same permission, so this returns the existing answer,
 * and Android will show it again. Either way the returned value is a real OS
 * answer, which is what the row then renders -- a switch that cannot change
 * state is visibly stuck, and it is stuck because the OS said so.
 */
export function withNotificationReask(
  facts: CapabilityFacts,
  onAsked: (granted: boolean) => void,
): PermissionRow[] {
  const { rows } = permissionRows(facts);
  return rows.map((row) =>
    row.key === 'alerts'
      ? {
          ...row,
          onPress: () => {
            void initNotifications().then(
              (answer) => onAsked(answer),
              () => onAsked(false),
            );
          },
        }
      : row,
  );
}
