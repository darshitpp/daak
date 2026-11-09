import type { ThreadItem } from '@daak/core';
import { threadItem } from '../testing/threadFixtures';
import {
  folderPlaces,
  folderState,
  folderStateWord,
  folderTree,
  groupThread,
  isLibraryPath,
  savedLine,
  type FolderRow,
} from './thread-groups';

const T1 = 'aa'.repeat(16);
const T2 = 'cc'.repeat(16);

/** One file of a folder. `rel` is the path below the folder. */
function child(rel: string, p: Partial<ThreadItem> = {}, name = 'album', files = 3, bytes = 3000): ThreadItem {
  return threadItem({
    transferId: T1,
    type: 'file',
    text: null,
    name: rel.split('/').pop() ?? rel,
    size: 1000,
    destPath: `/d/${name}/${rel}`,
    group: { name, rel, files, bytes },
    ...p,
  });
}

const folderOf = (rows: ReturnType<typeof groupThread>, i: number): FolderRow => {
  const r = rows[i];
  if (r.kind !== 'folder') throw new Error(`row ${i} is not a folder`);
  return r;
};

describe('groupThread', () => {
  it('groups_children_of_one_folder_into_one_row', () => {
    const rows = groupThread([child('a.txt', { itemIndex: 0 }), child('b.txt', { itemIndex: 1 }), child('c.txt', { itemIndex: 2 })]);
    expect(rows).toHaveLength(1);
    const f = folderOf(rows, 0);
    expect(f.name).toBe('album');
    expect(f.children.map((c) => c.itemIndex)).toEqual([0, 1, 2]);
    expect(f.transferId).toBe(T1);
    expect(f.direction).toBe('in');
  });

  it('keeps_a_loose_item_as_an_item_row', () => {
    const loose = threadItem({ transferId: T2, text: 'note' });
    const rows = groupThread([loose]);
    expect(rows).toEqual([{ kind: 'item', item: loose }]);
  });

  it('folder_takes_the_place_of_its_first_child', () => {
    const before = threadItem({ transferId: T2, itemIndex: 0, text: 'before' });
    const between = threadItem({ transferId: T2, itemIndex: 1, text: 'between' });
    const rows = groupThread([before, child('a.txt', { itemIndex: 0 }), between, child('b.txt', { itemIndex: 1 })]);
    expect(rows.map((r) => r.kind)).toEqual(['item', 'folder', 'item']);
    expect(folderOf(rows, 1).children).toHaveLength(2);
  });

  it('two_folders_in_one_transfer_stay_two_rows', () => {
    const rows = groupThread([
      child('a.txt', { itemIndex: 0 }, 'album'),
      child('b.txt', { itemIndex: 1 }, 'docs'),
      child('c.txt', { itemIndex: 2 }, 'album'),
    ]);
    expect(rows).toHaveLength(2);
    expect(folderOf(rows, 0).name).toBe('album');
    expect(folderOf(rows, 0).children).toHaveLength(2);
    expect(folderOf(rows, 1).name).toBe('docs');
    expect(folderOf(rows, 0).key).not.toBe(folderOf(rows, 1).key);
  });

  // Review Focus 2: the page budget can cut the children. The totals come from
  // the group, so the row does not shrink with the page.
  it('uses_group_totals_not_the_loaded_count', () => {
    const rows = groupThread([child('a.txt', {}, 'album', 12, 34_000_000)]);
    const f = folderOf(rows, 0);
    expect(f.files).toBe(12);
    expect(f.bytes).toBe(34_000_000);
    expect(f.cut).toBe(true);
    const whole = folderOf(groupThread([child('a.txt', {}, 'album', 1, 10)]), 0);
    expect(whole.cut).toBe(false);
  });
});

describe('folderState', () => {
  it('one_failed_child_makes_the_folder_failed', () => {
    const out = { direction: 'out' as const, transferState: 'done' };
    expect(folderState([child('a', out), child('b', { ...out, state: 'failed' })])).toBe('failed');
    expect(folderState([child('a'), child('b')])).toBe('done');
  });

  it('receiving_beats_failed', () => {
    expect(folderState([child('a', { state: 'failed' }), child('b', { state: 'receiving' })])).toBe('receiving');
    expect(folderState([child('a', { state: 'failed' }), child('b', { state: 'verifying' })])).toBe('receiving');
    const out = { direction: 'out' as const, transferState: 'active' };
    expect(folderState([child('a', { ...out, state: 'failed' }), child('b', { ...out, state: 'receiving' })])).toBe('sending');
  });

  it('names the held, waiting, trying, and stopped states', () => {
    expect(folderState([child('a'), child('b', { state: 'quarantined' })])).toBe('held');
    const out = (transferState: string) => ({ direction: 'out' as const, transferState, state: 'pending' as const });
    expect(folderState([child('a', out('queued'))])).toBe('waiting');
    expect(folderState([child('a', out('paused'))])).toBe('trying');
    expect(folderState([child('a', out('active'))])).toBe('sending');
    expect(folderState([child('a', { ...out('canceled'), state: 'failed' })])).toBe('stopped');
  });

  // The engine derives `receiving` for an inbound row with no item row, but a
  // `pending` inbound row is not "waiting to send".
  it('calls an inbound pending child receiving', () => {
    expect(folderState([child('a', { state: 'pending', transferState: 'active' })])).toBe('receiving');
  });
});

describe('folderTree', () => {
  it('tree_nests_subfolders_from_group_rel', () => {
    const top = child('top.txt');
    const mid = child('sub/mid.png');
    const deep = child('sub/deeper/deep.mov');
    const tree = folderTree([deep, top, mid]);
    expect(tree.map((n) => (n.kind === 'dir' ? `${n.name}/` : n.item.group?.rel))).toEqual(['sub/', 'top.txt']);
    const sub = tree[0];
    if (sub.kind !== 'dir') throw new Error('sub is not a dir');
    expect(sub.children.map((n) => (n.kind === 'dir' ? `${n.name}/` : n.item.group?.rel))).toEqual(['deeper/', 'sub/mid.png']);
    const deeper = sub.children[0];
    if (deeper.kind !== 'dir') throw new Error('deeper is not a dir');
    expect(deeper.children).toEqual([{ kind: 'file', item: deep }]);
  });
});

describe('folderPlaces', () => {
  it('reads both library path formats', () => {
    expect(isLibraryPath('photos:ABC/L0/001')).toBe(true);
    expect(isLibraryPath('content://media/external/images/media/12')).toBe(true);
    expect(isLibraryPath('/d/album/a.jpg')).toBe(false);
    expect(isLibraryPath(null)).toBe(false);
  });

  // Task 11: the strings that each native saveToLibrary returns. iOS returns
  // `"photos:" + localIdentifier`. Android returns the MediaStore insert URI.
  // These samples come from the native source. A device run must confirm them
  // (task 11 report, human checklist).
  it('native_library_paths_are_recognised_by_isLibraryPath', () => {
    expect(isLibraryPath('photos:6F1A2B3C-4D5E-4F70-8192-A3B4C5D6E7F8/L0/001')).toBe(true);
    expect(isLibraryPath('content://media/external/images/media/1000000034')).toBe(true);
    expect(isLibraryPath('content://media/external/video/media/1000000035')).toBe(true);
    // A file that moveReceivedFiles put in a SAF folder is not in the library.
    expect(
      isLibraryPath(
        'content://com.android.externalstorage.documents/tree/primary%3ADaak/document/primary%3ADaak%2Falbum%2Fa.pdf',
      ),
    ).toBe(false);
    // A file that moveReceivedFiles put in the iOS or macOS save folder.
    expect(isLibraryPath('/Users/me/Downloads/album/sub/a.pdf')).toBe(false);
  });

  it('places_is_mixed_when_some_children_are_library_paths', () => {
    const kids = [child('a.jpg', { destPath: 'photos:1' }), child('b.pdf')];
    expect(folderPlaces(kids, 1)).toBe('mixed');
    expect(folderPlaces([child('a.jpg', { destPath: 'content://media/x/1' })], 1)).toBe('library');
    expect(folderPlaces([child('b.pdf')], 0)).toBe('folder');
  });

  it('places_is_library_failed_when_media_stayed_in_the_save_folder', () => {
    expect(folderPlaces([child('a.jpg'), child('b.pdf')], 1)).toBe('library-failed');
  });

  it('places_is_null_for_a_sent_folder', () => {
    expect(folderPlaces([child('a.jpg', { direction: 'out', destPath: 'photos:1' })], 1)).toBeNull();
    // An unfinished folder has no place yet.
    expect(folderPlaces([child('a.jpg', { state: 'receiving' })], 1)).toBeNull();
  });
});

describe('savedLine', () => {
  it('saved_line_names_both_places_for_a_mixed_folder', () => {
    expect(savedLine('mixed', 'Photos', 'Daak')).toBe('Saved to Photos and Daak');
    expect(savedLine('library', 'Gallery', 'Downloads')).toBe('Saved to Gallery');
    expect(savedLine('folder', undefined, 'Downloads / Daak')).toBe('Saved to Downloads / Daak');
    expect(savedLine('library-failed', 'Photos', 'Daak')).toBe('Saved to Daak');
    expect(savedLine(null, 'Photos', 'Daak')).toBeNull();
    // A name that the host did not give makes no line.
    expect(savedLine('folder')).toBeNull();
  });
});

describe('folderStateWord', () => {
  it('says_how_many_files_of_a_received_folder_did_not_arrive', () => {
    const kids = [child('a', { state: 'failed' }), child('b', { state: 'failed' }), child('c', { state: 'done' })];
    const f = folderOf(groupThread(kids), 0);
    expect(f.state).toBe('failed');
    expect(folderStateWord(f)).toBe('2 of 3 did not arrive');
  });

  it('folderStateWord uses doneCount when given', () => {
    const kids = [child('a', { state: 'receiving' }), child('b', { state: 'receiving' }), child('c', { state: 'receiving' })];
    const f = folderOf(groupThread(kids), 0);
    expect(f.state).toBe('receiving');
    expect(folderStateWord(f)).toBe('Receiving 0 of 3');
    expect(folderStateWord(f, 2)).toBe('Receiving 2 of 3');
    expect(folderStateWord(f, 0)).toBe('Receiving 0 of 3');
  });
});
