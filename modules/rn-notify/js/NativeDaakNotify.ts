import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /** Real runtime-permission answer, not a re-prompt. */
  requestPermission(): Promise<boolean>;
  /** JSON array of `{ id, actions }`; installs OS categories/channels. */
  registerCategories(categoriesJson: string): Promise<void>;
  post(id: string, title: string, body: string, category: string, payloadJson: string): Promise<void>;
  cancel(id: string): Promise<void>;
  /**
   * Drains an action that was tapped while JS was not alive. `RCTEventEmitter`
   * drops an event with no listeners, and a notification is exactly the case
   * where there are none, so the native side stashes the last one and JS picks
   * it up here. JSON `{ action, payload }`, or `""` when there is nothing.
   */
  consumePendingAction(): Promise<string>;
  /**
   * JSON `{ "version": string, "build": string }` read from the app bundle:
   * CFBundleShortVersionString and CFBundleVersion on iOS, versionName and
   * versionCode on Android. A module that cannot read them rejects.
   */
  appInfo(): Promise<string>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('DaakNotify');
