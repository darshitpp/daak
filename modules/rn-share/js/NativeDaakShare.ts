import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  present(text: string, urls: string[], mime: string): Promise<void>;
  pickDocuments(multiple: boolean): Promise<string[]>;
  /**
   * Ask the user for ONE folder. Resolves the folder's path, or `null` when the
   * user cancels. Rejects with message `NO_SPACE:<needed bytes>` when the
   * private copy does not fit, or `EMPTY` when the folder holds no file.
   *
   * Optional until the iOS (Task 7) and Android (Task 8) bodies land. The
   * Android codegen makes a required method abstract, so a required method
   * with no Kotlin body breaks the build. The facade rejects when it is absent.
   */
  pickFolder?(): Promise<string | null>;
  consumePendingInbox(): Promise<string>;
  /** Drains ONLY `share-inbox/intent-sends/`. Never touches `batches/`. */
  consumeIntentSends(): Promise<string>;
  /** Publishes the peer list: Android shortcuts, iOS App Group `pairedDevices`. */
  updateShortcutTargets(devicesJson: string): Promise<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('DaakShare');
