/**
 * What the Permissions step may claim, derived from what this build can do.
 *
 * The design has one row: "Alerts when a file arrives". It is optional.
 *
 * Discovery and local network are not rows. The engine starts discovery inside
 * `engine.start()`, no JavaScript API reads or requests the local-network grant,
 * and `DaakEngine` has no `stopDiscovery`. A row for either would show a
 * control that changes nothing. iOS shows its own prompt on the first browse.
 *
 * This is a local type, not an import from `@daak/ui`. `@daak/ui` depends on
 * `@daak/core` and nothing else, and an upward import would invert that. The
 * shape equals `PermissionRowSpec` in `@daak/ui`.
 */
import { initNotifications } from './notify';

export type PermissionSwitchState = 'on' | 'off' | 'unavailable';

export interface PermissionRow {
  key: string;
  title: string;
  sub: string;
  state: PermissionSwitchState;
  /** Omitted means locked: reported, but the step cannot change it. */
  onPress?: () => void;
}

export const ALERTS_TITLE = 'Alerts when a file arrives';
export const ALERTS_SUB = 'A short banner so you know something came in.';

export interface CapabilityFacts {
  /**
   * The real `initNotifications()` result: whether the OS lets Daak post an
   * arrival banner. `undefined` means nobody asked yet. That is the first-launch
   * state and it is not the same as denied.
   */
  notificationsGranted?: boolean;
}

export function permissionRows(facts: CapabilityFacts): { rows: PermissionRow[] } {
  return {
    rows: [
      {
        key: 'alerts',
        title: ALERTS_TITLE,
        sub: ALERTS_SUB,
        state: facts.notificationsGranted === true ? 'on' : 'off',
      },
    ],
  };
}

/**
 * The same rows with a real re-ask bound to the alerts row.
 *
 * `initNotifications()` is idempotent by platform. iOS does not show the system
 * prompt twice, so the call returns the existing answer. Android shows it again.
 * Either way the value is a real OS answer, and the row renders that value.
 */
export function withNotificationReask(
  facts: CapabilityFacts,
  onAsked: (granted: boolean) => void,
): PermissionRow[] {
  return permissionRows(facts).rows.map((row) =>
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

