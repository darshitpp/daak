import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  install(): Promise<void>;
  setTitle(title: string): Promise<void>;
  setMenu(itemsJson: string): Promise<void>;
  setPopoverVisible(visible: boolean): Promise<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('DaakTray');
