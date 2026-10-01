import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /**
   * `null` is "no such key" (a first launch), NOT an error. A REJECT is a
   * keystore that is locked or unavailable, and the engine must refuse to start
   * rather than fall back to a plaintext store.
   */
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<boolean>;
  remove(key: string): Promise<boolean>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('DaakSecureStore');
