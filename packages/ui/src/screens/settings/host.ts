/**
 * The functions the Settings screen calls. Every field is INJECTED, because
 * `packages/ui` takes no `@daak/platform` dependency: the preference store,
 * the app version, and the OS notification grant all live behind native calls
 * that this package must not import.
 */
export interface NotifyPrefsLike {
  arrival: boolean;
}

export interface SettingsHost {
  /** Reads "Version {version} (build {build})" for About. Async, because the native read is async (P2). */
  appInfo?: () => Promise<{ version: string; build: string }>;
  /** The arrival switch. Absent: the whole section is hidden. */
  notifyPrefs?: { load: () => Promise<NotifyPrefsLike>; save: (p: NotifyPrefsLike) => Promise<void> };
  /** The OS grant. `granted()` undefined means "not asked yet". */
  osAlerts?: { granted: () => Promise<boolean | undefined>; openSettings?: () => void };
  /** Label of the network row in Connection. Default 'This Wi-Fi'. The macOS host passes 'Network'. */
  networkLabel?: string;
}

