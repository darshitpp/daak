// The desktop notification's action model. Deliberately a SEPARATE file from
// system-notify.ts even though the brief suggested folding it in, and the reason
// is TDD, not tidiness: this file imports NOTHING, so test/actions.spec.ts can
// import it in plain Node under vitest with no alias, no stub and no
// TurboModuleRegistry. The moment buildNotification lives next to notifyInbox it
// would need one (see system-notify.ts).
//
// NOT on the mobile-reachable barrel (modules/rn-notify/js/index.ts) -- read the
// comment there.

// The three fields of @daak/core's InboxEntry that buildNotification reads,
// declared as a local structural subset rather than imported.
//
// This is the reason this module has NO entry in "dependencies". The plan's
// package.json adds { "@daak/core": "workspace:*" }, but this package is a
// dependency of packages/platform and apps/mobile, and the Task 5 precedent set
// the bar the other way: modules/rn-share/package.json has NO "dependencies"
// block at all, and its js/items.ts declares SharePayload locally for the same
// reason. A structural subset is assignable FROM the real InboxEntry without a
// dependency edge, so callers keep passing engine values unchanged and this
// module stays a leaf.
//
// Only the read fields are required. The engine's InboxEntry has eight fields
// (payloadId, transferId, peerDeviceId, kind, itemCount, summary, receivedAt,
// savedPaths -- packages/core/src/engine/types.ts:11-26) and all are required,
// but requiring all eight here would mean a test fixture has to invent
// transferId and receivedAt to prove a title pluralises. The engine is the
// source of truth for the entry; this is the projection of it that the banner
// needs, and a wider InboxEntry satisfies it for free.
//
// Task 12 adds 2 optional fields. `groupRoots` and `savedPaths` give the folder
// name and the file count. They are optional, so an old engine entry and a
// test fixture without them still fit.
export interface InboxNotificationEntry {
  payloadId: string;
  itemCount: number;
  summary: string;
  groupRoots?: string[];
  savedPaths?: string[] | null;
}

export interface NotifyAction {
  id: 'open' | 'share' | 'show';
  label: string;
}

export interface DesktopNotification {
  payloadId: string;
  category: 'daak.inbox';
  title: string;
  body: string;
  actions: NotifyAction[];
}

export function inboxActions(): NotifyAction[] {
  // R37, applied to desktop the way packages/platform/src/notify.ts:10-18
  // applies it to mobile, and with the same precedent in
  // modules/rn-notify/ios/DaakNotify.swift:26-33, where 'daak.folder' is named
  // in the vocabulary and deliberately NOT installed.
  //
  // 'share' is WITHHELD: re-sharing a received payload is the mobile DaakShare
  // outbound path, and the desktop inbound inbox has no re-share surface at
  // all. Installing it would hand the user a button that foregrounds the app
  // and then does nothing.
  //
  // 'show' ("Show in folder") is WITHHELD: reveal has no implementation, and
  // its label promises Finder. The honest options were to implement reveal or
  // to drop the button, and Phase 6 ruled the button out. It was briefly
  // aliased onto openDashboard, which is a lie by the label.
  //
  // TO ADD EITHER BACK, in ONE commit, all four of:
  //   1. this list,
  //   2. the matching action registration in the daak.inbox category table in
  //      macos/RNNotify.mm,
  //   3. the real effect in apps/desktop/src/notify.ts's planNotifyAction and
  //      its NotifyHost,
  //   4. the withhold assertions in modules/rn-notify/test/actions.spec.ts.
  //
  // A button is a promise. Withhold it until there is something to keep.
  return [
    { id: 'open', label: 'Open' },
  ];
}

// The engine's InboxEntry has a REAL itemCount -- the plan's `as any` fixture
// was hiding a field that exists, and `unit` below is the only reason this
// function needs a number at all.
// A folder entry uses the folder text (receivedText). A loose entry keeps the
// old text.
export function buildNotification(entry: InboxNotificationEntry): DesktopNotification {
  const unit = entry.itemCount === 1 ? 'item' : 'items';
  const folder = receivedText(entry);
  return {
    payloadId: entry.payloadId,
    category: 'daak.inbox',
    title: folder?.title ?? `Received ${entry.itemCount} ${unit}`,
    body: folder?.body ?? entry.summary,
    actions: inboxActions(),
  };
}

/** `1 file`, `12 files`. */
function files(n: number): string {
  return `${n} ${n === 1 ? 'file' : 'files'}`;
}

/**
 * The folders of a received entry. Each folder has its name (the last
 * component of the root) and the indexes of the `savedPaths` below the root.
 *
 * Call this with the entry of the `inbox.received` event, from BEFORE the move.
 * After a move to Photos or Gallery a path is not below its root any more. The
 * move keeps the order and the length of `savedPaths`, so an index also points
 * at the path after the move.
 *
 * A root matches only on a whole component. The longest root wins.
 */
export function receivedFolders(entry: InboxNotificationEntry): { name: string; indexes: number[] }[] {
  const roots = (entry.groupRoots ?? []).map((r) => r.replace(/\/+$/, '')).filter((r) => r !== '');
  const folders = roots.map((r) => ({ name: r.slice(r.lastIndexOf('/') + 1), indexes: [] as number[] }));
  (entry.savedPaths ?? []).forEach((path, i) => {
    let best = -1;
    roots.forEach((root, k) => {
      if (path.startsWith(root + '/') && (best < 0 || root.length > roots[best].length)) best = k;
    });
    if (best >= 0) folders[best].indexes.push(i);
  });
  return folders.filter((f) => f.indexes.length > 0);
}

/** The words for the places of a mixed folder. The host knows them. */
export interface ReceivedPlaces {
  /** `Photos` on iOS, `Gallery` on Android. */
  library?: string;
  /** The folder name that Settings shows. */
  saveFolder?: string;
  /** The rule of `isLibraryPath` in packages/ui. The host passes it in. */
  inLibrary: (path: string) => boolean;
}

/**
 * The title and body of a received folder, or null for loose files.
 *
 * `entry` is the event entry from before the move. `moved` is the result of the
 * move, in the same order. A folder with some files in the library and some
 * not adds the line `Photos and videos: {library}. Other files: {saveFolder}.`
 */
export function receivedText(
  entry: InboxNotificationEntry,
  moved?: readonly string[] | null,
  places?: ReceivedPlaces,
): { title: string; body: string } | null {
  const folders = receivedFolders(entry);
  if (folders.length === 0) return null;
  const lines = folders.map((f) => `${f.name} · ${files(f.indexes.length)}`);
  const inFolders = folders.reduce((n, f) => n + f.indexes.length, 0);
  const loose = (entry.savedPaths?.length ?? 0) - inFolders;
  if (loose > 0) lines.push(`and ${loose} other ${loose === 1 ? 'file' : 'files'}`);
  const mixed =
    moved != null &&
    places !== undefined &&
    folders.some((f) => {
      const inLib = f.indexes.filter((i) => places.inLibrary(moved[i] ?? '')).length;
      return inLib > 0 && inLib < f.indexes.length;
    });
  if (mixed && places?.library && places.saveFolder) {
    lines.push(`Photos and videos: ${places.library}. Other files: ${places.saveFolder}.`);
  }
  return {
    title: folders.length === 1 ? 'Received a folder' : `Received ${folders.length} folders`,
    body: lines.join('\n'),
  };
}

/**
 * The 2 engine reads that `failedSendNotice` makes. A structural subset, for
 * the reason the top of this file gives: this module imports nothing. Both are
 * reads. Nothing here sends (R33).
 */
export interface FailedSendEngine {
  listTransfers(): Promise<
    { transferId: string; peerDeviceId: string; direction: 'in' | 'out'; itemCount: number; updatedAt: number }[]
  >;
  listThread(peerDeviceId: string): Promise<{
    items: { transferId: string; type: 'text' | 'file'; name: string | null; group?: { name: string } | null }[];
  }>;
}

export interface FailedSendNotice {
  transferId: string;
  peerDeviceId: string;
  /**
   * The `updatedAt` of the transfer row. `Engine::retry` keeps the transfer id
   * and writes a new time, so `transferId:updatedAt` names one failure (see
   * `failureKey`).
   */
  updatedAt: number;
  title: string;
  body: string;
}

/**
 * The notification for a send that ended in a failure, or null when nothing
 * must post.
 *
 * Call it on `transfer.failed`. The engine sends that event once, at the end,
 * and never on a retry back-off. An all-zero id is an inbound failure, and an
 * inbound row is not a send, so both give null. `{name}` is the folder name,
 * the file name of one file, or `{N} files`.
 */
export async function failedSendNotice(engine: FailedSendEngine, transferId: string): Promise<FailedSendNotice | null> {
  if (/^0*$/.test(transferId)) return null;
  const row = (await engine.listTransfers()).find((t) => t.transferId === transferId);
  if (row === undefined || row.direction !== 'out') return null;
  const items = (await engine.listThread(row.peerDeviceId)).items.filter((i) => i.transferId === transferId);
  const groups = new Set(items.map((i) => i.group?.name));
  let name: string;
  if (items.length > 0 && groups.size === 1 && !groups.has(undefined)) name = [...groups][0] as string;
  else if (row.itemCount === 1 && items.length === 1) name = items[0].type === 'text' ? 'a note' : items[0].name ?? files(1);
  else {
    const count = Math.max(row.itemCount, items.length);
    if (count === 0) return null;
    name = files(count);
  }
  return {
    transferId,
    peerDeviceId: row.peerDeviceId,
    updatedAt: row.updatedAt,
    title: `Couldn't send ${name}`,
    body: 'Open Daak to try again.',
  };
}

/**
 * The key of one failure. A repeat of the same event gives the same key. A
 * retry that fails again gives a new key, because the retry writes a new
 * `updatedAt` on the row. Do not key on the transfer id alone: a retried send
 * that fails again would then post nothing.
 */
export function failureKey(notice: Pick<FailedSendNotice, 'transferId' | 'updatedAt'>): string {
  return `${notice.transferId}:${notice.updatedAt}`;
}

/**
 * The Mac form of a failed-send notification. Its own id, so it does not
 * replace a received banner. The same category and the same Open action as a
 * received banner, so a click opens Daak in the same way.
 */
export function buildFailedNotification(notice: FailedSendNotice): DesktopNotification {
  return {
    payloadId: `failed:${notice.transferId}`,
    category: 'daak.inbox',
    title: notice.title,
    body: notice.body,
    actions: inboxActions(),
  };
}
