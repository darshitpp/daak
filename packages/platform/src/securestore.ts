import NativeDaakSecureStore from '@daak/rn-securestore';

/**
 * The OS keystore, as a JS-facing surface.
 *
 * JS does NOT use this to hold the device identity: the Rust engine talks to
 * the native keystore DIRECTLY, through the UniFFI SecureStore callback the
 * engine TurboModule implements, so the identity key never crosses into a JS
 * value at all. This wrapper exists for the app's own small secrets and so the
 * OS keystore has exactly one address in the JS layer.
 */
export async function secureGet(key: string): Promise<string | null> {
  return NativeDaakSecureStore.get(key);
}

export async function secureSet(key: string, value: string): Promise<boolean> {
  return NativeDaakSecureStore.set(key, value);
}

export async function secureDelete(key: string): Promise<boolean> {
  return NativeDaakSecureStore.delete(key);
}
