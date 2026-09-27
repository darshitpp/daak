import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /** `false` reports that the OS refused the write, not an exception. */
  setString(text: string): Promise<boolean>;
  getString(): Promise<string>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('DaakClipboard');
