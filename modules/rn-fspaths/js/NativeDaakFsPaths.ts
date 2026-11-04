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
   * The size in bytes of each path, in the same order as `paths`. `null` means
   * unknown: the file is missing, unreadable, or not a regular file. It is an
   * ANSWER for one path, never a rejection of the whole call.
   */
  fileSizes(paths: string[]): Promise<(number | null)[]>;
  /**
   * The file count and total bytes of a folder tree. Symlinks are skipped.
   * Resolves `null` when the path is not a readable folder.
   *
   * This method and the next two are required. iOS, Android, and macOS
   * implement all three.
   */
  folderStats(path: string): Promise<{ files: number; bytes: number } | null>;
  /** Delete the private copy that `pickFolder` made. A no-op on macOS. */
  discardPickedCopy(path: string): Promise<void>;
  /** Delete every private copy that an earlier run left. A no-op on macOS. */
  sweepPickedCopies(): Promise<void>;
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
   *
   * `subdirs[i]` is the folder below the remembered folder for `paths[i]`, for
   * example `album/sub`. `''` is the top of the folder. The array has one entry
   * for each path. A file that is already in the save folder answers its own
   * path and does not move. After the move, the empty folders that the engine
   * made below its output directory are removed.
   * The first name is the root. A root gets a free name (`album-1`), but a
   * subdir that starts with `/` names a root that the native move uses as is.
   */
  moveReceivedFiles(paths: string[], subdirs: string[]): Promise<string[]>;
  /**
   * Add each image or video to the OS media library, answering one string per
   * input, in order. A saved file answers a MARKER (`photos:<id>` on iOS, a
   * `content://` URI on Android) and the engine copy is deleted. A file that
   * was not saved answers its ORIGINAL path: no permission, an unsupported
   * type, an API level below 29, or any failure. It never rejects.
   *
   * `albums[i]` is the album for `paths[i]`, for example `album / sub`. `''` is
   * no album. The array has one entry for each path. iOS makes a new Photos
   * album with that title for each call. Add-only access cannot look up albums. Android uses `Pictures/Daak/album/sub` (or
   * `Movies/Daak/...`). macOS ignores it.
   */
  saveToLibrary(paths: string[], albums: string[]): Promise<string[]>;
  /**
   * Ask for add-only access to the photo library. `true` when access is
   * granted. Android needs no permission and answers `true`. macOS has no
   * library support yet and answers `false`.
   */
  requestPhotosAccess(): Promise<boolean>;
  /**
   * The current add-only access, without a prompt. One of `granted`, `denied`,
   * `undetermined`, or `unavailable`. The type is `string` because the codegen
   * contract has no literal unions elsewhere. The facade narrows it.
   */
  photosAccessStatus(): Promise<string>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('DaakFsPaths');
