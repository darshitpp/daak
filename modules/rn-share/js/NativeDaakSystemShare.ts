import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  share(payloadJson: string): Promise<void>;
  /**
   * Absolute paths, in selection order. A CANCELLED panel resolves with an
   * EMPTY array and never rejects: a user dismissing a picker is not an error,
   * and a reject surfaces as a red box in the shipped app.
   *
   * Same signature the mobile `DaakShare` module already has
   * (NativeDaakShare.pickDocuments), deliberately: the composer's picker is
   * INJECTED, so both platforms hand it the identical `() => Promise<string[]>`
   * and packages/ui cannot tell them apart. It lives on THIS module, not on a
   * `DaakShare` for macOS, because js/index.ts records in prose why the mobile
   * and desktop modules must not share a barrel.
   */
  pickDocuments(multiple: boolean): Promise<string[]>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('DaakSystemShare');
