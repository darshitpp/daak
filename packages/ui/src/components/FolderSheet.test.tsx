import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ThreadItem } from '@daak/core';
import { humanBytes } from '../screens/quarantine-facts';
import type { FolderPlaces, FolderRow } from '../screens/thread-groups';
import { threadItem } from '../testing/threadFixtures';
import { FolderSheet } from './FolderSheet';

const BYTES = 34 * 1024 * 1024;

function kid(rel: string, p: Partial<ThreadItem> = {}, files = 3): ThreadItem {
  return threadItem({
    itemIndex: rel.length,
    type: 'file',
    text: null,
    name: rel.split('/').pop() ?? rel,
    size: 4096,
    destPath: `/d/album/${rel}`,
    group: { name: 'album', rel, files, bytes: BYTES },
    ...p,
  });
}

function row(children: ThreadItem[], p: Partial<FolderRow> = {}): FolderRow {
  return {
    kind: 'folder',
    key: 'bb:album',
    transferId: 'bb'.repeat(16),
    direction: children[0]?.direction ?? 'in',
    name: 'album',
    files: children[0]?.group?.files ?? children.length,
    bytes: BYTES,
    state: 'done',
    at: 1_700_000_000,
    children,
    cut: false,
    ...p,
  };
}

function mount(r: FolderRow, p: Partial<React.ComponentProps<typeof FolderSheet>> = {}) {
  const props = {
    onClose: jest.fn(),
    onRetry: jest.fn(),
    onStop: jest.fn(),
    places: null as FolderPlaces | null,
    ...p,
  };
  render(<FolderSheet row={r} open {...props} />);
  return props;
}

const indent = (testID: string): number => {
  const s = StyleSheet.flatten(screen.getByTestId(testID).props.style) as { paddingLeft?: number };
  return s.paddingLeft ?? 0;
};

describe('FolderSheet', () => {
  it('shows the name, the sub line, and the tree with indented children', () => {
    mount(row([kid('top.txt'), kid('sub/mid.png'), kid('sub/deep/deep.mov')]), { places: 'folder', saveFolder: 'Daak' });
    expect(screen.getByText('album')).toBeTruthy();
    expect(screen.getByText(`3 files · ${humanBytes(BYTES)} · Saved to Daak`)).toBeTruthy();
    expect(screen.getByText('top.txt')).toBeTruthy();
    expect(screen.getByText('sub/')).toBeTruthy();
    expect(screen.getByText('deep/')).toBeTruthy();
    expect(indent('folder-file-top.txt')).toBe(0);
    expect(indent('folder-file-sub/mid.png')).toBeGreaterThan(0);
    expect(indent('folder-file-sub/deep/deep.mov')).toBeGreaterThan(indent('folder-file-sub/mid.png'));
  });

  it('folds a subfolder and unfolds it again', () => {
    mount(row([kid('top.txt'), kid('sub/mid.png')]));
    expect(screen.getByText('mid.png')).toBeTruthy();
    fireEvent.press(screen.getByTestId('folder-dir-sub'));
    expect(screen.queryByText('mid.png')).toBeNull();
    fireEvent.press(screen.getByTestId('folder-dir-sub'));
    expect(screen.getByText('mid.png')).toBeTruthy();
  });

  it('shows Couldn\'t send and a Retry for a failed sent child', () => {
    const bad = kid('notes.pdf', { direction: 'out', state: 'failed', transferState: 'done' });
    const good = kid('top.txt', { direction: 'out', transferState: 'done' });
    const p = mount(row([good, bad], { state: 'failed', direction: 'out' }));
    expect(screen.getByText("Couldn't send")).toBeTruthy();
    expect(screen.getAllByText('Retry')).toHaveLength(1);
    fireEvent.press(screen.getByLabelText('Retry sending notes.pdf'));
    expect(p.onRetry).toHaveBeenCalledWith(bad);
  });

  it('shows no Retry for a failed received child', () => {
    mount(row([kid('notes.pdf', { state: 'failed', error: 'The hash did not match' })], { state: 'failed' }));
    expect(screen.getByText('The hash did not match')).toBeTruthy();
    expect(screen.queryByText('Retry')).toBeNull();
  });

  it('keeps Review on a held child', () => {
    const held = kid('x.bin', { state: 'quarantined' });
    const onOpenHeld = jest.fn();
    mount(row([held], { state: 'held' }), { onOpenHeld });
    expect(screen.getByText('Held back')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Review x.bin'));
    expect(onOpenHeld).toHaveBeenCalledWith(held);
  });

  it('keeps Preview and Share on a file that has a path', () => {
    const f = kid('top.txt');
    const onPreview = jest.fn();
    const onShare = jest.fn();
    mount(row([f]), { onPreview, onShare });
    fireEvent.press(screen.getByLabelText('Preview top.txt'));
    fireEvent.press(screen.getByLabelText('Share top.txt'));
    expect(onPreview).toHaveBeenCalledWith(f);
    expect(onShare).toHaveBeenCalledWith(f);
  });

  it('shows Stop once, for a sent folder that waits, and calls onStop', () => {
    const waiting = { direction: 'out' as const, state: 'pending' as const, transferState: 'queued' };
    const r = row([kid('a.txt', waiting), kid('b.txt', waiting)], { state: 'waiting', direction: 'out' });
    const p = mount(r);
    expect(screen.getAllByText('Stop')).toHaveLength(1);
    fireEvent.press(screen.getByTestId('folder-stop'));
    expect(p.onStop).toHaveBeenCalledWith(r);
  });

  it('shows Stop once for a sent folder in the retry back-off', () => {
    const paused = { direction: 'out' as const, state: 'pending' as const, transferState: 'paused' };
    const r = row([kid('a.txt', paused)], { state: 'trying', direction: 'out' });
    const p = mount(r);
    expect(screen.getAllByText('Stop')).toHaveLength(1);
    fireEvent.press(screen.getByTestId('folder-stop'));
    expect(p.onStop).toHaveBeenCalledWith(r);
  });

  it.each([
    ['sending', 'out'],
    ['done', 'out'],
    ['receiving', 'in'],
  ] as const)('shows no Stop for a %s %s folder', (state, direction) => {
    mount(row([kid('a.txt', { direction })], { state, direction }));
    expect(screen.queryByText('Stop')).toBeNull();
  });

  it('closes on Done', () => {
    const p = mount(row([kid('a.txt')]));
    fireEvent.press(screen.getByTestId('folder-done'));
    expect(p.onClose).toHaveBeenCalled();
  });

  it('says how many files a cut row shows', () => {
    mount(row([kid('a.txt', {}, 200), kid('b.txt', {}, 200)], { files: 200, cut: true }));
    expect(screen.getByText('Showing the first 2 of 200 files')).toBeTruthy();
  });

  describe('location help', () => {
    const lib = kid('a.jpg', { destPath: 'photos:1' });
    const doc = kid('b.pdf');

    it('mixed: the banner and a tag on each file row', () => {
      mount(row([lib, doc]), { places: 'mixed', library: 'Photos', saveFolder: 'Daak' });
      expect(screen.getByText('Photos and videos are in Photos. Other files are in Daak / album.')).toBeTruthy();
      expect(screen.getByText(`${humanBytes(4096)} · In Photos`)).toBeTruthy();
      expect(screen.getByText(`${humanBytes(4096)} · In Daak`)).toBeTruthy();
    });

    it('library on iOS: the album banner and no tag', () => {
      mount(row([lib]), { places: 'library', library: 'Photos', saveFolder: 'Daak' });
      expect(screen.getByText('Find it in Photos, under the album "album".')).toBeTruthy();
      expect(screen.queryByText(/In Photos/)).toBeNull();
    });

    it('library on Android: the Daak folder banner', () => {
      mount(row([kid('a.jpg', { destPath: 'content://media/1' })]), { places: 'library', library: 'Gallery', saveFolder: 'Downloads' });
      expect(screen.getByText('Find it in Gallery, in the Daak folder under "album".')).toBeTruthy();
    });

    it('library-failed: the banner says where the files are', () => {
      mount(row([kid('a.jpg'), doc]), { places: 'library-failed', library: 'Gallery', saveFolder: 'Downloads' });
      expect(screen.getByText("Couldn't save to Gallery. All files are in Downloads / album.")).toBeTruthy();
      expect(screen.queryByText(/In Downloads/)).toBeNull();
    });

    it.each(['folder', null] as const)('%s: no banner and no tag', (places) => {
      mount(row([doc]), { places, library: 'Photos', saveFolder: 'Daak' });
      expect(screen.queryByTestId('folder-banner')).toBeNull();
      expect(screen.queryByText(/In Daak|In Photos/)).toBeNull();
    });
  });

  it('each file row in the open folder gets its own fill from percentOf', () => {
    const a = kid('a.bin', { itemIndex: 0, state: 'receiving', transferState: 'running' });
    const b = kid('b.bin', { itemIndex: 1, state: 'receiving', transferState: 'running' });
    mount(row([a, b], { state: 'receiving' }), { percentOf: (i: ThreadItem) => (i.itemIndex === 0 ? 100 : 40) });
    const t = (id: string) => StyleSheet.flatten(screen.getByTestId(id).props.style).transform;
    expect(t('folder-file-fill-a.bin')).toEqual([{ scaleX: 1 }]);
    expect(t('folder-file-fill-b.bin')).toEqual([{ scaleX: 0.4 }]);
  });

  it('a file row draws no fill without percentOf or for a done file', () => {
    const a = kid('a.bin', { itemIndex: 0, state: 'receiving', transferState: 'running' });
    const d = kid('d.bin', { itemIndex: 1 });
    mount(row([a, d], { state: 'receiving' }), { percentOf: (i: ThreadItem) => (i.itemIndex === 0 ? undefined : 100) });
    expect(screen.queryByTestId('folder-file-fill-a.bin')).toBeNull();
    expect(screen.queryByTestId('folder-file-fill-d.bin')).toBeNull();
  });
});
