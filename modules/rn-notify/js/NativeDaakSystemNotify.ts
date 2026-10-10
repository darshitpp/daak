import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  notify(payloadJson: string): Promise<void>;
  /**
   * JSON `{ "version": string, "build": string }` read from the app bundle:
   * CFBundleShortVersionString and CFBundleVersion on macOS.
   */
  appInfo(): Promise<string>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('DaakSystemNotify');
