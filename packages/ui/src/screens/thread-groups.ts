import type { ThreadItem } from '@daak/core';
import { bubbleKind } from '../components/Bubble';

/** The state of a whole folder. The bubble shows one word for it. */
export type FolderState = 'receiving' | 'sending' | 'waiting' | 'trying' | 'failed' | 'held' | 'stopped' | 'done';

/** One folder of one transfer. It takes the place of its children in the thread. */
export type FolderRow = {
  kind: 'folder';
  /** `<transferId>:<folder name>`. A transfer can hold 2 folders. */
  key: string;
  transferId: string;
  direction: 'in' | 'out';
  name: string;
  /** The totals of the whole folder, from `group`. Not the loaded count. */
  files: number;
  bytes: number;
  state: FolderState;
  at: number;
  children: ThreadItem[];
  /** The page holds fewer children than `files`. */
  cut: boolean;
};

export type Row = { kind: 'item'; item: ThreadItem } | FolderRow;

export type TreeNode = { kind: 'dir'; name: string; children: TreeNode[] } | { kind: 'file'; item: ThreadItem };

/** Where the files of a received folder are. */
export type FolderPlaces = 'library' | 'folder' | 'mixed' | 'library-failed';

const busy = (i: ThreadItem): boolean => i.state === 'receiving' || i.state === 'verifying';

export function folderState(children: ThreadItem[]): FolderState {
  const out = children[0]?.direction === 'out';
  const transfer = children[0]?.transferState;
  if (children.some(busy)) return out ? 'sending' : 'receiving';
  // The engine marks the items of a stopped send as failed. Stopped wins.
  if (children.some((c) => bubbleKind(c) === 'stopped') || (out && transfer === 'canceled')) return 'stopped';
  if (children.some((c) => bubbleKind(c) === 'failed')) return 'failed';
  if (children.some((c) => c.state === 'quarantined')) return 'held';
  if (children.some((c) => bubbleKind(c) === 'waiting')) return transfer === 'paused' ? 'trying' : 'waiting';
  // An inbound pending item is on its way. It does not wait for this device.
  if (children.some((c) => c.state === 'pending')) return out ? (transfer === 'active' ? 'sending' : 'waiting') : 'receiving';
  return 'done';
}

/**
 * Folds the children of each folder into one row. The order stays. A folder
 * row takes the place of its first child.
 */
export function groupThread(items: ThreadItem[]): Row[] {
  const rows: Row[] = [];
  const folders = new Map<string, FolderRow>();
  for (const item of items) {
    const g = item.group;
    if (g === null || g === undefined) {
      rows.push({ kind: 'item', item });
      continue;
    }
    const key = `${item.transferId}:${g.name}`;
    const found = folders.get(key);
    if (found !== undefined) {
      found.children.push(item);
      continue;
    }
    const row: FolderRow = {
      kind: 'folder',
      key,
      transferId: item.transferId,
      direction: item.direction,
      name: g.name,
      files: g.files,
      bytes: g.bytes,
      state: 'done',
      at: item.at,
      children: [item],
      cut: false,
    };
    folders.set(key, row);
    rows.push(row);
  }
  for (const f of folders.values()) {
    f.state = folderState(f.children);
    f.cut = f.children.length < f.files;
  }
  return rows;
}

/**
 * The tree of a folder, from `group.rel`. The children sort by `rel`, because
 * the saved paths can arrive in an order that is not the manifest order.
 */
export function folderTree(children: ThreadItem[]): TreeNode[] {
  const rel = (i: ThreadItem): string => i.group?.rel ?? i.name ?? '';
  const sorted = [...children].sort((a, b) => (rel(a) < rel(b) ? -1 : rel(a) > rel(b) ? 1 : 0));
  const root: TreeNode[] = [];
  for (const item of sorted) {
    const parts = rel(item).split('/').filter(Boolean);
    let level = root;
    for (const dir of parts.slice(0, -1)) {
      let node = level.find((n): n is Extract<TreeNode, { kind: 'dir' }> => n.kind === 'dir' && n.name === dir);
      if (node === undefined) {
        node = { kind: 'dir', name: dir, children: [] };
        level.push(node);
      }
      level = node.children;
    }
    level.push({ kind: 'file', item });
  }
  return root;
}

/** A path in Photos (iOS) or in the Android media store. Task 10 pins both formats. */
export function isLibraryPath(destPath: string | null): boolean {
  return destPath !== null && (destPath.startsWith('photos:') || destPath.startsWith('content://media/'));
}

/**
 * Where the files of a received folder went. null for a sent folder or a
 * folder that is not done. `mediaCount` is the number of children with a media
 * extension. The host counts them, because the extension list is in
 * `packages/platform`.
 */
export function folderPlaces(children: ThreadItem[], mediaCount: number): FolderPlaces | null {
  if (children.length === 0 || children.some((c) => c.direction !== 'in' || c.state !== 'done')) return null;
  const inLibrary = children.filter((c) => isLibraryPath(c.destPath)).length;
  if (inLibrary === children.length) return 'library';
  if (inLibrary > 0) return 'mixed';
  return mediaCount > 0 ? 'library-failed' : 'folder';
}

/** The "Saved to" line of a done received folder. null when a name is missing. */
export function savedLine(places: FolderPlaces | null, library?: string, saveFolder?: string): string | null {
  switch (places) {
    case 'library':
      return library ? `Saved to ${library}` : null;
    case 'mixed':
      return library && saveFolder ? `Saved to ${library} and ${saveFolder}` : null;
    case 'folder':
    case 'library-failed':
      return saveFolder ? `Saved to ${saveFolder}` : null;
    default:
      return null;
  }
}

/** `12 files · 34.0 MB`. */
export function folderSub(row: Pick<FolderRow, 'files'>, size: string): string {
  return [`${row.files} ${row.files === 1 ? 'file' : 'files'}`, size].filter(Boolean).join(' · ');
}

/**
 * The state word of a folder. null for a done folder: the saved line stands there.
 * `doneCount` replaces the count of children in state `done`.
 */
export function folderStateWord(row: Pick<FolderRow, 'state' | 'files' | 'children' | 'direction'>, doneCount?: number): string | null {
  const done = doneCount ?? row.children.filter((c) => c.state === 'done').length;
  const failed = row.children.filter((c) => bubbleKind(c) === 'failed').length;
  switch (row.state) {
    case 'receiving':
      return `Receiving ${done} of ${row.files}`;
    case 'sending':
      return `Sending ${done} of ${row.files}`;
    case 'waiting':
      return 'Waiting to send';
    case 'trying':
      return 'Trying again';
    case 'failed':
      return row.direction === 'out' ? `Couldn't send ${failed} of ${row.files}` : `${failed} of ${row.files} did not arrive`;
    case 'held':
      return 'Held back';
    case 'stopped':
      return 'Stopped';
    default:
      return null;
  }
}
