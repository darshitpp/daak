import NativeDaakFsPaths from '@daak/rn-fspaths';

/**
 * Every path this returns is inside the app sandbox. The engine's data dir is
 * resolved NATIVELY (DaakModule.kt / Daak.swift), not from here, because
 * InProcessEngine.start() takes no arguments and passes '' -- so the one
 * honest answer to "where is the data dir" is the OS's own.
 */
export async function documentsDir(): Promise<string> {
  return NativeDaakFsPaths.documentsDir();
}

export async function downloadsDir(): Promise<string> {
  return NativeDaakFsPaths.downloadsDir();
}

/**
 * The App Group container dir on iOS, and "" on Android, which has no App
 * Group. "" is an ANSWER, not a failure: returning filesDir there would be a
 * lie about sharing, because the Android share extension is a separate
 * package with its own private filesDir. Callers must branch on the empty
 * string rather than treat it as an error.
 */
export async function appGroupDir(): Promise<string> {
  return NativeDaakFsPaths.appGroupDir();
}

/**
 * Resolves false where reveal is not implemented. iOS is a no-op by design
 * (R41) and the daak.folder notification action stays withheld on BOTH
 * platforms, so no UI path can reach this yet. It is here so the reveal a
 * later task owns has one address instead of a third ad-hoc binding.
 */
export async function revealInFileManager(path: string): Promise<boolean> {
  return NativeDaakFsPaths.reveal(path);
}

/**
 * Opens a received file in the OS viewer. This is the Preview verb of the
 * thread. `revealInFileManager` is a different verb: it shows the file in the
 * file manager, and iOS has no such API (R41). Resolves false when no viewer
 * started, and also when the native call rejects, because the caller is a
 * button handler that must not die on an unhandled rejection.
 */
export async function openFile(path: string): Promise<boolean> {
  try {
    return (await NativeDaakFsPaths.openFile(path)) === true;
  } catch {
    return false;
  }
}

/**
 * R42p: where received files should end up, and the move that puts them there.
 *
 * The engine writes into its own app-storage folder and the platform moves the
 * files afterwards, because an Android SAF tree has no path the engine can
 * write to. `moveReceivedFiles` with no folder remembered returns the input
 * unchanged, so the whole feature degrades to the old behavior until the user
 * chooses one.
 */
export async function chooseDownloadFolder(): Promise<string | null> {
  // `?? null` is the whole point of this facade line. A CANCELLED picker
  // resolves `nil` natively, and the bridge can deliver `undefined` for it
  // rather than `null`. Every caller reads this contract as `string | null`:
  // DownloadFolderRow treats `null` as "the user cancelled, change nothing"
  // and ANY other value as a new name, so an `undefined` set its name to
  // undefined, the row fell back to "This app's own storage", and a folder the
  // user still had was CLEARED. Measured on the iPhone 17 simulator: closing
  // the picker reverted a folder that had just been chosen. The platform layer
  // is where a bridge quirk is absorbed, so it is fixed here and not in each
  // caller.
  const raw = (await NativeDaakFsPaths.chooseDownloadFolder()) ?? null;
  return raw === null ? null : friendlyFolderName(raw);
}

export async function downloadFolderName(): Promise<string | null> {
  const raw = (await NativeDaakFsPaths.downloadFolderName()) ?? null;
  return raw === null ? null : friendlyFolderName(raw);
}

const MAX_FOLDER_NAME = 40;

function capMiddle(s: string): string {
  if (s.length <= MAX_FOLDER_NAME) return s;
  const keep = MAX_FOLDER_NAME - 1;
  const head = Math.ceil(keep / 2);
  return `${s.slice(0, head)}\u2026${s.slice(s.length - (keep - head))}`;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Turns the raw folder value from the native module into a short name for the
 * screen. Android gives a SAF tree URI. iOS and macOS give a full path. A value
 * that has no usable segment comes back unchanged, so the function never erases
 * a value it cannot parse. A result has at most 40 characters.
 */
export function friendlyFolderName(raw: string): string {
  const saf = /^content:\/\/([^/]+)\/tree\/([^/]*)/.exec(raw);
  if (saf) {
    const authority = saf[1];
    const id = safeDecode(saf[2]);
    if (authority === 'com.android.externalstorage.documents') {
      const colon = id.indexOf(':');
      if (colon >= 0) {
        const volume = id.slice(0, colon);
        const rel = id.slice(colon + 1).replace(/^\/+|\/+$/g, '');
        if (volume === 'primary') return capMiddle(rel || 'Internal storage');
        return capMiddle(rel ? `SD card / ${rel}` : 'SD card');
      }
    }
    const last = id.split('/').filter(Boolean).pop();
    return capMiddle(last ?? authority.split('.').slice(-2).join('.'));
  }
  if (raw.startsWith('content://')) return raw;

  const parts = raw.split('/').filter(Boolean);
  const cloud = parts.indexOf('com~apple~CloudDocs');
  if (cloud >= 0) {
    return capMiddle(['iCloud Drive', ...parts.slice(cloud + 1)].join(' / '));
  }
  if (parts.length === 0) return raw;
  return capMiddle(parts.slice(-2).join(' / '));
}

export async function clearDownloadFolder(): Promise<void> {
  return NativeDaakFsPaths.clearDownloadFolder();
}

export async function moveReceivedFiles(paths: string[]): Promise<string[]> {
  return NativeDaakFsPaths.moveReceivedFiles(paths);
}

export type PhotosAccess = 'granted' | 'denied' | 'undetermined' | 'unavailable';

export async function saveToLibrary(paths: string[]): Promise<string[]> {
  return NativeDaakFsPaths.saveToLibrary(paths);
}

export async function requestPhotosAccess(): Promise<boolean> {
  try {
    return (await NativeDaakFsPaths.requestPhotosAccess()) === true;
  } catch {
    return false;
  }
}

export async function photosAccessStatus(): Promise<PhotosAccess> {
  try {
    const status = await NativeDaakFsPaths.photosAccessStatus();
    return status === 'granted' || status === 'denied' || status === 'undetermined'
      ? status
      : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

// The JavaScript side picks candidates by extension, because an InboxEntry has
// no per-file type. The native side may still refuse a file it cannot add.
const MEDIA_EXT = new Set([
  'jpg', 'jpeg', 'png', 'heic', 'gif', 'webp', 'mp4', 'mov', 'm4v', '3gp', 'mkv',
]);

function isMedia(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot >= 0 && MEDIA_EXT.has(path.slice(dot + 1).toLowerCase());
}

/**
 * R42p: put a received payload's files where the user asked for them, and tell
 * the engine where they went.
 *
 * NEVER throws. It runs inside the app's ONE engine event handler, where an
 * unhandled rejection would kill the subscription and with it every later
 * notification and pairing publish -- the same reason routeInboxEntry has that
 * shape. A move that fails leaves the engine's own path untouched, which is the
 * honest resting state: the file is still where the engine put it.
 *
 * The engine is told ONLY when something moved. A payload with no saved paths,
 * or one whose files all stayed put, needs no write, and a write per receive
 * for nothing is a row rewritten on every arrival.
 *
 * Media files go to the OS media library first (`saveToLibrary`). Each file
 * that the library did not take then goes to the chosen folder.
 *
 * RETURNS the locations the move produced, or null when nothing moved. The
 * caller needs them because a notification is a SNAPSHOT: its payload JSON is
 * baked into the notification's extras at post time, so a banner posted before
 * the move carries paths the move then DELETES.
 */
export async function relocateReceivedFiles(
  engine: { replaceInboxPaths(payloadId: string, paths: string[]): Promise<void> },
  payload: { payloadId: string; savedPaths: string[] | null },
): Promise<string[] | null> {
  const before = payload.savedPaths;
  if (!before || before.length === 0) return null;
  const after = [...before];

  // Step 1: the media library. A failure leaves the paths as they are.
  const mediaAt = before.flatMap((p, i) => (isMedia(p) ? [i] : []));
  if (mediaAt.length > 0) {
    try {
      const saved = await saveToLibrary(mediaAt.map((i) => before[i]));
      if (saved.length === mediaAt.length) {
        mediaAt.forEach((at, k) => {
          after[at] = saved[k];
        });
      }
    } catch {
      // Nothing was saved. The folder move below still runs.
    }
  }

  // Step 2: the chosen folder, for every path that is still the original.
  const stillAt = before.flatMap((p, i) => (after[i] === p ? [i] : []));
  if (stillAt.length > 0) {
    try {
      const moved = await moveReceivedFiles(stillAt.map((i) => after[i]));
      if (moved.length === stillAt.length) {
        stillAt.forEach((at, k) => {
          after[at] = moved[k];
        });
      }
    } catch {
      // The files stay where they are.
    }
  }

  if (after.every((p, i) => p === before[i])) return null;
  try {
    await engine.replaceInboxPaths(payload.payloadId, after);
  } catch {
    // The files moved and the row still names the old place. Nothing else is
    // safe to do from here: the next receive rewrites the row it cares about,
    // and a retry loop in an event handler is worse than a stale path.
  }
  // Returned even when the DB write above lost: the FILES moved, and the
  // caller needs where they really are.
  return after;
}

/**
 * Whether a path exists. Resolves false rather than rejecting for a path that
 * is not there, on both platforms, so a reveal action never has to catch. Not
 * called anywhere yet -- the UI that needs it is a later task -- but the plan
 * names it, so it lives here next to the other four rather than being
 * reinvented under a second name when that task lands.
 */
export async function exists(path: string): Promise<boolean> {
  return NativeDaakFsPaths.exists(path);
}

/**
 * The size in bytes of each path, in the same order. `null` is an unknown size.
 * Resolves `null` for every path when the native call rejects, so the review
 * sheet shows names and no total instead of an error.
 */
export async function fileSizes(paths: string[]): Promise<(number | null)[]> {
  try {
    return await NativeDaakFsPaths.fileSizes(paths);
  } catch {
    return paths.map(() => null);
  }
}
