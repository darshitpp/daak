import { secureGet, secureSet } from './securestore';

/**
 * Has this device been through onboarding, and what did the user turn on?
 *
 * The prototype's first three screens (Welcome, Name Device, Permissions) ask
 * two questions that are facts about the INSTALL, not about the network, and
 * both must survive a relaunch: a user who named this phone should not be
 * asked again, and a user who declined arrival alerts must not be nagged on
 * every launch. That makes the answer state, not a prop.
 *
 * It lives in the OS keystore ([`secureGet`]/[`secureSet`]) rather than in
 * SQLite because it is read BEFORE the engine is usable -- the engine is not
 * started until onboarding is done, and the naming screen is what starts it.
 * SQLite would mean starting the engine to ask whether to start the engine.
 * A rejected read is deliberately NOT treated as "not onboarded": that would
 * re-run onboarding on a keystore that is merely locked, which is how a user
 * ends up re-pairing a device they already paired. A rejection propagates and
 * the caller shows an error instead.
 */
const KEY = 'onboarding.v1';

export interface OnboardingState {
  /** Welcome -> Name Device -> Permissions -> Pair has been completed. */
  complete: boolean;
  /** The name the user typed, if they have ever typed one. */
  name?: string;
  /** "Find devices on this Wi-Fi" -- required before Continue is enabled. */
  discovery: boolean;
  /** "Tell me when a file arrives". A decline is remembered, not re-asked. */
  alerts: boolean;
}

/**
 * A first launch. `discovery` starts FALSE because the prototype gates
 * Continue on it (`perm-go` is disabled until both are on), and a fresh
 * install has asked for nothing.
 */
export const INITIAL_ONBOARDING: OnboardingState = {
  complete: false,
  discovery: false,
  alerts: false,
};

export async function readOnboarding(): Promise<OnboardingState> {
  const raw = await secureGet(KEY);
  if (raw === null) return INITIAL_ONBOARDING;
  try {
    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    return {
      // Defaulting a MISSING flag to true would grant a permission the user
      // never agreed to, and the Permissions screen would render its switches
      // on while nothing was ever asked. Default to false, then let an explicit
      // stored true speak.
      complete: parsed.complete === true,
      name: typeof parsed.name === 'string' && parsed.name !== '' ? parsed.name : undefined,
      discovery: parsed.discovery === true,
      alerts: parsed.alerts === true,
    };
  } catch {
    // Corrupt JSON is not a keystore failure and must not reject: refusing to
    // launch over a garbled flag is worse than re-asking two questions. It is
    // the same shape as a first launch, and the next write repairs it.
    return INITIAL_ONBOARDING;
  }
}

export async function writeOnboarding(state: OnboardingState): Promise<boolean> {
  return secureSet(KEY, JSON.stringify(state));
}
