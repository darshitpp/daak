import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  present(text: string, urls: string[], mime: string): Promise<void>;
  pickDocuments(multiple: boolean): Promise<string[]>;
  consumePendingInbox(): Promise<string>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('DaakShare');
