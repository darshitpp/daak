import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  present(text: string, urls: string[], mime: string): Promise<void>;
  pickDocuments(multiple: boolean): Promise<string[]>;
  /**
   * Ask the user for ONE folder. Resolves the folder's path, or `null` when the
   * user cancels. Rejects with message `NO_SPACE:<needed bytes>` when the
   * private copy does not fit, `EMPTY` when the folder holds no file, or
   * `NOT_DOWNLOADED` (iOS only) when an iCloud Drive file is not on the device.
   *
   * Required: iOS and Android implement it. macOS does not register this
   * module (it uses DaakSystemShare), so the facade still checks for it.
   */
  pickFolder(): Promise<string | null>;
  /**
   * Ask the user for photos and videos. Resolves JSON text of
   * `Array<{ token: string; name: string; size: number | null }>`. The pick
   * copies nothing. A cancel gives `[]`. Required: the facade still checks for
   * it, because macOS does not register this module.
   */
  pickMedia(): Promise<string>;
  /**
   * Copy ONE picked item into `<cache>/daak-send/<uuid>/` and resolve the
   * absolute path of the copy. Rejects with code `NO_SPACE` (message
   * `NO_SPACE:<needed bytes>`), `E_SOURCE_GONE`, or `E_MATERIALIZE`.
   */
  materialize(token: string): Promise<string>;
  /**
   * Give back the persisted read grants of picked media. `tokensJson` is JSON
   * text of `string[]` (the tokens of `pickMedia`). A bad entry is ignored.
   * Android only: iOS holds no URI grants and resolves at once. Never rejects.
   */
  releaseMedia(tokensJson: string): Promise<void>;
  consumePendingInbox(): Promise<string>;
  /** Drains ONLY `share-inbox/intent-sends/`. Never touches `batches/`. */
  consumeIntentSends(): Promise<string>;
  /** Publishes the peer list: Android shortcuts, iOS App Group `pairedDevices`. */
  updateShortcutTargets(devicesJson: string): Promise<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('DaakShare');
