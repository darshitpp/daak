import { secureGet, secureSet } from './securestore';

/**
 * The app preference for the arrival message. It is NOT the OS grant.
 *
 * The OS permission is a separate fact. `permission-rows.ts` reports it, and
 * `initNotifications` asks for it. A banner appears only when BOTH are on.
 *
 * The design has one switch, "Tell me when a file arrives". It has no sound
 * switch, so the banner uses the platform default sound behavior.
 *
 * The store is the keystore, the same store `onboarding.ts` uses for its flags.
 * Desktop and mobile both read it through `secureGet`, so one key serves both.
 * The flags are read before the engine starts, and a preference must not need
 * SQLite for the same reason.
 */
const KEY = 'notify.prefs.v1';

export interface NotifyPrefs {
  /** "Tell me when a file arrives". */
  arrival: boolean;
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = { arrival: true };

/**
 * NEVER rejects. The caller is the inbox event handler. A locked keystore or a
 * corrupt value must cost the user at most the default banner, never a lost
 * receive (R36). A field that is missing or is not a boolean defaults to ON.
 */
export async function loadNotifyPrefs(): Promise<NotifyPrefs> {
  let raw: string | null;
  try {
    raw = await secureGet(KEY);
  } catch {
    return { ...DEFAULT_NOTIFY_PREFS };
  }
  // `== null`: the bridge can deliver undefined for a missing key.
  if (raw == null) return { ...DEFAULT_NOTIFY_PREFS };
  try {
    const parsed: unknown = JSON.parse(raw);
    const fields =
      typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    return {
      arrival: typeof fields.arrival === 'boolean' ? fields.arrival : DEFAULT_NOTIFY_PREFS.arrival,
    };
  } catch {
    return { ...DEFAULT_NOTIFY_PREFS };
  }
}

export async function saveNotifyPrefs(prefs: NotifyPrefs): Promise<void> {
  const written = await secureSet(KEY, JSON.stringify({ arrival: prefs.arrival }));
  if (!written) throw new Error('notify prefs: the keystore refused the write');
}
