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
 * R42p: where received files should end up, and the move that puts them there.
 *
 * The engine writes into its own app-storage folder and the platform moves the
 * files afterwards, because an Android SAF tree has no path the engine can
 * write to. `moveReceivedFiles` with no folder remembered returns the input
 * unchanged, so the whole feature degrades to the old behavior until the user
 * chooses one.
 */
export async function chooseDownloadFolder(): Promise<string | null> {
  return NativeDaakFsPaths.chooseDownloadFolder();
}

export async function downloadFolderName(): Promise<string | null> {
  return NativeDaakFsPaths.downloadFolderName();
}

export async function clearDownloadFolder(): Promise<void> {
  return NativeDaakFsPaths.clearDownloadFolder();
}

export async function moveReceivedFiles(paths: string[]): Promise<string[]> {
  return NativeDaakFsPaths.moveReceivedFiles(paths);
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
 */
export async function relocateReceivedFiles(
  engine: { replaceInboxPaths(payloadId: string, paths: string[]): Promise<void> },
  payload: { payloadId: string; savedPaths: string[] | null },
): Promise<void> {
  const before = payload.savedPaths;
  if (!before || before.length === 0) return;
  let after: string[];
  try {
    after = await moveReceivedFiles(before);
  } catch {
    return;
  }
  if (after.length !== before.length) return;
  if (after.every((p, i) => p === before[i])) return;
  try {
    await engine.replaceInboxPaths(payload.payloadId, after);
  } catch {
    // The files moved and the row still names the old place. Nothing else is
    // safe to do from here: the next receive rewrites the row it cares about,
    // and a retry loop in an event handler is worse than a stale path.
  }
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
