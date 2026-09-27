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
 * Whether a path exists. Resolves false rather than rejecting for a path that
 * is not there, on both platforms, so a reveal action never has to catch. Not
 * called anywhere yet -- the UI that needs it is a later task -- but the plan
 * names it, so it lives here next to the other four rather than being
 * reinvented under a second name when that task lands.
 */
export async function exists(path: string): Promise<boolean> {
  return NativeDaakFsPaths.exists(path);
}
