import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /** Presents the camera and resolves with the decoded QR payload string. */
  scan(): Promise<string>;
  /**
   * Resolves with a `data:image/png;base64,...` URI for `payload` rendered at
   * roughly `size` pixels. The host half of pairing renders the bundle here;
   * the joiner scans it back with scan().
   */
  generate(payload: string, size: number): Promise<string>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('DaakQrScanner');
