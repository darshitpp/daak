import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /** The app's own documents dir. ALWAYS inside the app sandbox. */
  documentsDir(): Promise<string>;
  /** The app's downloads dir. ALWAYS inside the app sandbox. */
  downloadsDir(): Promise<string>;
  /**
   * The shared container dir, or `""` when the platform has no App Group.
   * `""` is an ANSWER, not a failure: JS must not create a relative dir.
   */
  appGroupDir(): Promise<string>;
  /** Reveals a saved file in the OS file manager. `false` = not supported here. */
  reveal(path: string): Promise<boolean>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('DaakFsPaths');
