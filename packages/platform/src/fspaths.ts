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

// Resolves the name of the folder that receives files. It resolves null when
// the platform has no public folder to name. It does not mean "not chosen":
// Android API 29 and later returns the default public folder after a reset.
export async function downloadFolderName(): Promise<string | null> {
  const raw = (await NativeDaakFsPaths.downloadFolderName()) ?? null;
  return raw === null ? null : friendlyFolderName(raw);
}

const MAX_FOLDER_NAME = 40;

function capMiddle(s: string): string {
  const chars = Array.from(s);
  if (chars.length <= MAX_FOLDER_NAME) return s;
  const keep = MAX_FOLDER_NAME - 1;
  const head = Math.ceil(keep / 2);
  return `${chars.slice(0, head).join('')}\u2026${chars.slice(chars.length - (keep - head)).join('')}`;
}

// Returns null when the text has a malformed percent sequence.
function strictDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

// The last non-empty segment of a URI path. A malformed segment stays as it is.
function lastSegment(path: string): string | undefined {
  const last = path.split('/').filter(Boolean).pop();
  return last === undefined ? undefined : (strictDecode(last) ?? last);
}

function authorityName(authority: string): string {
  return authority.split('.').slice(-2).join('.');
}

const SD_VOLUME = /^[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}$/;

function volumeName(volume: string, rest: string): string {
  const rel = rest.replace(/^\/+|\/+$/g, '');
  if (volume === 'primary') return rel || 'Internal storage';
  if (volume === 'raw') return rest.replace(/\/+$/, '');
  const label = volume === 'home' ? 'Documents' : SD_VOLUME.test(volume) ? 'SD card' : volume;
  return rel ? `${label} / ${rel}` : label;
}

/**
 * Turns the raw folder value from the native module into a short name for the
 * screen. Android gives a content URI. iOS and macOS give a full path. A value
 * that has no usable segment comes back unchanged, so the function never erases
 * a value it cannot parse. A result has at most 40 code points. A content URI
 * never comes back raw.
 */
export function friendlyFolderName(raw: string): string {
  const uri = /^content:\/\/([^/]+)(\/.*)?$/.exec(raw);
  if (uri) {
    const authority = uri[1];
    const path = uri[2] ?? '';
    const tree = /^\/tree\/([^/]*)/.exec(path);
    const id = tree ? strictDecode(tree[1]) : null;
    if (tree && id !== null) {
      const colon = id.indexOf(':');
      if (authority === 'com.android.externalstorage.documents' && colon >= 0) {
        return capMiddle(volumeName(id.slice(0, colon), id.slice(colon + 1)));
      }
      const last = id.split('/').filter(Boolean).pop();
      return capMiddle(last ?? authorityName(authority));
    }
    return capMiddle(lastSegment(path) ?? authorityName(authority));
  }

  const parts = raw.split(/[\\/]/).filter(Boolean);
  const cloud = parts.indexOf('com~apple~CloudDocs');
  if (cloud >= 0) {
    return capMiddle(['iCloud Drive', ...parts.slice(cloud + 1)].join(' / '));
  }
  if (parts.length === 0) return raw;
  return capMiddle(parts.slice(-2).join(' / '));
}

/**
 * The name of the default public folder on Android 29 and later. The native
 * module returns the raw value `Download/Daak` when the user chose no folder.
 * The host uses this label to see that default. It comes from
 * `friendlyFolderName`, so the two cannot differ.
 */
export const DEFAULT_PUBLIC_FOLDER_LABEL = friendlyFolderName('Download/Daak');

export async function clearDownloadFolder(): Promise<void> {
  return NativeDaakFsPaths.clearDownloadFolder();
}

// The native methods always get a second array with one entry for each path.
// An Objective-C selector has a fixed argument list, so a call with 1 argument
// cannot reach a method with 2. A missing entry is ''.
function parallel(paths: string[], extra?: string[]): string[] {
  return paths.map((_, i) => extra?.[i] ?? '');
}

/**
 * `subdirs[i]` is the folder inside the save folder for `paths[i]`, for example
 * `album/sub`. A shorter array, or `''`, means the top of the save folder. A
 * file that is already at its place comes back with its own path.
 *
 * Task 12b (F4): the first name of a subdir is the root. In one call, the
 * native move gives each root the first free name in the save folder (`album`,
 * `album-1`, `album-2`). It never merges into a folder that exists. A subdir
 * that starts with `/` (`/album-1/sub`) names a root that the payload already
 * uses. The native move uses that root as it is, so a retry joins it.
 */
export async function moveReceivedFiles(paths: string[], subdirs?: string[]): Promise<string[]> {
  const run = moveQueue.then(() => NativeDaakFsPaths.moveReceivedFiles(paths, parallel(paths, subdirs)));
  // The next move waits for this move to settle. A failed move does not stop
  // the next move. The caller of this move still gets its own error.
  moveQueue = run.catch(() => undefined);
  return run;
}

// The native move checks for a free root name, then creates it. Two calls at
// the same time can pick the same root and merge two folders. So one call
// runs at a time.
let moveQueue: Promise<unknown> = Promise.resolve();

export type PhotosAccess = 'granted' | 'denied' | 'undetermined' | 'unavailable';

/**
 * `albums[i]` is the album (iOS) or the folder below `Pictures/Daak` (Android)
 * for `paths[i]`, for example `album / sub`. A shorter array, or `''`, means no
 * album, as for a loose file.
 */
export async function saveToLibrary(paths: string[], albums?: string[]): Promise<string[]> {
  return NativeDaakFsPaths.saveToLibrary(paths, parallel(paths, albums));
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

export function isMedia(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot >= 0 && MEDIA_EXT.has(path.slice(dot + 1).toLowerCase());
}

export type RelocationPlan = {
  library: { index: number; path: string; album: string; subdir: string }[];
  folder: { index: number; path: string; subdir: string }[];
};

// A path that is already in Photos (`photos:<id>`) or in Gallery or a SAF
// folder (`content://`) moved at an earlier event. It does not move again.
function alreadyMoved(path: string): boolean {
  return path.startsWith('photos:') || path.startsWith('content://');
}

// The folder of `path` from the parent of its group root, for example
// `album/sub`. `''` for a path under no root. The longest root wins, and a root
// matches only on a whole path component, so `/out/photos` does not match
// `/out/photos-1/a.jpg`. The leaf of the root is the folder name on disk, so a
// suffixed folder keeps its suffix. It handles only `/` separators. Windows is
// not released.
function rootOf(path: string, roots: string[]): string {
  let best = '';
  for (const raw of roots) {
    const root = raw.replace(/\/+$/, '');
    if (root.length > best.length && path.startsWith(`${root}/`)) best = root;
  }
  return best;
}

function subdirOf(path: string, roots: string[]): string {
  const best = rootOf(path, roots);
  if (best === '') return '';
  const name = best.slice(best.lastIndexOf('/') + 1);
  const dirs = path.slice(best.length + 1).split('/').slice(0, -1);
  return [name, ...dirs].join('/');
}

type Place = { parent: string; leaf: string };

// A SAF document URI: `content://<authority>/tree/<tree id>/document/<doc id>`.
const SAF_DOC = /^content:\/\/[^/]+\/tree\/([^/]+)\/document\/([^/]+)$/;

// The folder of a moved file on Android, from its SAF document URI. A path
// style document id (the local storage provider) gives `<tree id>/<root>/...`.
// Any other id names no folder. A loose file names no folder.
function safPlace(path: string): Place | null {
  const m = SAF_DOC.exec(path);
  if (!m) return null;
  let tree: string;
  let doc: string;
  try {
    tree = decodeURIComponent(m[1]);
    doc = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  if (!doc.startsWith(`${tree}/`)) return null;
  const parts = doc.slice(tree.length + 1).split('/');
  if (parts.length < 2 || parts[0] === '') return null;
  return { parent: `saf:${tree}`, leaf: parts[0] };
}

// Every folder of this payload: each group root, and each SAF folder of a file
// that moved on Android.
function placesOf(savedPaths: string[], groupRoots: string[]): Place[] {
  const places: Place[] = groupRoots.map((raw) => {
    const root = raw.replace(/\/+$/, '');
    const cut = root.lastIndexOf('/');
    return { parent: root.slice(0, cut), leaf: root.slice(cut + 1) };
  });
  for (const path of savedPaths) {
    const place = safPlace(path);
    if (place) places.push(place);
  }
  return places;
}

/**
 * Task 12b (F4): the save folder root that this payload already uses for the
 * group at `root`, or null. The native move chose that root as the first free
 * name of the group folder name, so it is `leaf` or `leaf-<number>`.
 *
 * Only a folder in another parent counts. The engine puts every group root in
 * one output folder, so a root in the same parent is an engine root.
 *
 * Only exactly one match counts. The exact name does not win, because
 * another group can own it: groups `album` and `album-1` can move to
 * `album-1` and `album-1-1`. When two names match, the answer is null, so the
 * native move makes a new folder. A new folder is safer than a merge into the
 * wrong folder.
 */
function placedRoot(root: string, places: Place[]): string | null {
  if (root === '') return null;
  const cut = root.lastIndexOf('/');
  const parent = root.slice(0, cut);
  const leaf = root.slice(cut + 1);
  const suffixed = new RegExp(`^${leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+$`);
  const names = new Set(
    places
      .filter((p) => p.parent !== parent && (p.leaf === leaf || suffixed.test(p.leaf)))
      .map((p) => p.leaf),
  );
  return names.size === 1 ? [...names][0] : null;
}

/**
 * Where each received file goes. `index` is the position in `savedPaths`.
 *
 * - A media file (by extension) goes to `library` when `photosOn` is true. Its
 *   `album` is the folder path joined with ` / ` (spec C8).
 * - Every other file goes to `folder`. Its `subdir` keeps the folder structure
 *   inside the save folder.
 * - A loose file has `album` and `subdir` as `''`.
 * - A group that already has a root in the save folder (an earlier move of
 *   this payload) gets that root with a leading `/` in `subdir`, for example
 *   `/album-1/sub`. The `album` keeps the name on disk in the app folder.
 * - A path that starts with `photos:` or `content://` is in no list. It moved
 *   at an earlier `inbox.received` event of the same payload.
 */
export function planRelocation(
  savedPaths: string[],
  groupRoots: string[],
  photosOn: boolean,
): RelocationPlan {
  const plan: RelocationPlan = { library: [], folder: [] };
  const places = placesOf(savedPaths, groupRoots);
  savedPaths.forEach((path, index) => {
    if (alreadyMoved(path)) return;
    const subdir = subdirOf(path, groupRoots);
    const placed = placedRoot(rootOf(path, groupRoots), places);
    // A leading `/` tells the native move to use this root as it is.
    const target = placed === null ? subdir : `/${[placed, ...subdir.split('/').slice(1)].join('/')}`;
    if (photosOn && isMedia(path)) {
      plan.library.push({ index, path, album: subdir.split('/').join(' / '), subdir: target });
    } else {
      plan.folder.push({ index, path, subdir: target });
    }
  });
  return plan;
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
 * that the library did not take then goes to the chosen folder, inside its
 * group folder. The native side decides if the library is on: a target with
 * no routing answers each original path, so the fallback move takes the file.
 *
 * A repaired folder sends a second `inbox.received` for the same payload. A
 * path that moved to the library is skipped (`planRelocation`). A path that is
 * already in the save folder goes to the native move, which answers its own
 * path. The same path is "no move", so the row is not rewritten for it.
 *
 * Each native answer is used only when its length is correct, because
 * `replaceInboxPaths` pairs the old and new lists by index.
 *
 * RETURNS the locations the move produced, or null when nothing moved. The
 * caller needs them because a notification is a SNAPSHOT: its payload JSON is
 * baked into the notification's extras at post time, so a banner posted before
 * the move carries paths the move then DELETES. The caller keeps the event
 * entry, so the name and the count stay readable from it.
 */
export async function relocateReceivedFiles(
  engine: { replaceInboxPaths(payloadId: string, paths: string[]): Promise<void> },
  payload: { payloadId: string; savedPaths: string[] | null; groupRoots: string[] },
): Promise<string[] | null> {
  const before = payload.savedPaths;
  if (!before || before.length === 0) return null;
  const after = [...before];
  const plan = planRelocation(before, payload.groupRoots, true);

  // Step 1: the media library. A failure leaves the paths as they are.
  if (plan.library.length > 0) {
    try {
      const saved = await saveToLibrary(
        plan.library.map((e) => e.path),
        plan.library.map((e) => e.album),
      );
      if (saved.length === plan.library.length) {
        plan.library.forEach((e, k) => {
          after[e.index] = saved[k];
        });
      }
    } catch {
      // Nothing was saved. The folder move below still runs.
    }
  }

  // Step 2: the chosen folder, for each planned file that is still at its
  // original path. A media file that the library did not take keeps its
  // folder structure: each library entry has its own subdir.
  const stillAt = [...plan.library, ...plan.folder]
    .filter((e) => after[e.index] === before[e.index])
    .sort((a, b) => a.index - b.index);
  if (stillAt.length > 0) {
    try {
      const moved = await moveReceivedFiles(
        stillAt.map((e) => before[e.index]),
        stillAt.map((e) => e.subdir),
      );
      if (moved.length === stillAt.length) {
        stillAt.forEach((e, k) => {
          after[e.index] = moved[k];
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

/**
 * The file count and total bytes of a folder tree. Resolves `null` when the
 * native call rejects or is absent, so the review sheet shows a name and no
 * total instead of an error.
 */
export async function folderStats(path: string): Promise<{ files: number; bytes: number } | null> {
  try {
    return (await NativeDaakFsPaths.folderStats?.(path)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Delete the private copy that `pickFolder` made. Never rejects: it is cleanup
 * and runs from a handler that must not die. A copy that stays is removed by
 * `sweepPickedCopies` at the next start.
 */
export async function discardPickedCopy(path: string): Promise<void> {
  try {
    await NativeDaakFsPaths.discardPickedCopy?.(path);
  } catch {
    // The sweep at the next start removes the copy.
  }
}

/** Delete every private copy that an earlier run left. Never rejects. */
export async function sweepPickedCopies(): Promise<void> {
  try {
    await NativeDaakFsPaths.sweepPickedCopies?.();
  } catch {
    // Nothing to do. The next start tries again.
  }
}
