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
  /**
   * Opens a received file in the OS viewer: QuickLook on iOS, the default app
   * on macOS, `ACTION_VIEW` through the file provider on Android. `false` means
   * no viewer started (no such file, no app for the type). It is an answer and
   * not an error.
   */
  openFile(path: string): Promise<boolean>;
  /**
   * Whether a path exists. Resolves false, never rejects, for a path that is
   * not there: "no such file" is an answer here, and a reveal action must not
   * die on an unhandled rejection.
   */
  exists(path: string): Promise<boolean>;
  /**
   * R42p: ask the OS for a folder to keep received files in, and REMEMBER it.
   * Resolves the folder's display name, or `null` when the user cancelled.
   */
  chooseDownloadFolder(): Promise<string | null>;
  /** The remembered folder's display name, or `null` when none was chosen. */
  downloadFolderName(): Promise<string | null>;
  /** Forget the folder. Later receives stay in the app's own storage. */
  clearDownloadFolder(): Promise<void>;
  /**
   * MOVE each received file into the remembered folder, answering the new
   * location for each, in the same order.
   *
   * With no folder remembered, or when a move fails, the ORIGINAL path comes
   * back for that entry: the file is still where the engine put it, and one
   * failure must not lose the location of the others.
   */
  moveReceivedFiles(paths: string[]): Promise<string[]>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('DaakFsPaths');
