import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { humanBytes } from '../screens/quarantine-facts';
import type { FolderRow, FolderState } from '../screens/thread-groups';
import { colors } from '../theme';
import { threadItem } from '../testing/threadFixtures';
import { FolderBubble } from './FolderBubble';

const BYTES = 34 * 1024 * 1024;
const SIZE = humanBytes(BYTES);

function row(p: Partial<FolderRow> = {}): FolderRow {
  const kids = Array.from({ length: 12 }, (_, i) =>
    threadItem({
      itemIndex: i,
      type: 'file',
      text: null,
      name: `f${i}.jpg`,
      size: 1000,
      group: { name: 'album', rel: `f${i}.jpg`, files: 12, bytes: BYTES },
      state: i < 4 ? 'done' : 'receiving',
    }),
  );
  return {
    kind: 'folder',
    key: 'bb:album',
    transferId: 'bb'.repeat(16),
    direction: 'in',
    name: 'album',
    files: 12,
    bytes: BYTES,
    state: 'done',
    at: 1_700_000_000,
    children: kids,
    cut: false,
    ...p,
  };
}

describe('FolderBubble', () => {
  it('shows the name, the file count and size, and the saved line', () => {
    render(<FolderBubble row={row()} savedLine="Saved to Photos" onOpen={jest.fn()} />);
    expect(screen.getByText('album')).toBeTruthy();
    expect(screen.getByText(`12 files · ${SIZE}`)).toBeTruthy();
    expect(screen.getByText('Saved to Photos')).toBeTruthy();
    expect(screen.getByTestId('bubble-folder-bb:album')).toBeTruthy();
  });

  it('says 1 file for one file', () => {
    render(<FolderBubble row={row({ files: 1 })} savedLine={null} onOpen={jest.fn()} />);
    expect(screen.getByText(`1 file · ${SIZE}`)).toBeTruthy();
  });

  // Four of the twelve fixture children are done.
  const words: [FolderState, 'in' | 'out', string][] = [
    ['receiving', 'in', 'Receiving 4 of 12'],
    ['sending', 'out', 'Sending 4 of 12'],
    ['waiting', 'out', 'Waiting to send'],
    ['trying', 'out', 'Trying again'],
    ['held', 'in', 'Held back'],
    ['stopped', 'out', 'Stopped'],
  ];
  it.each(words)('shows the state word for %s', (state, direction, word) => {
    render(<FolderBubble row={row({ state, direction })} savedLine="Saved to Photos" onOpen={jest.fn()} />);
    expect(screen.getByText(word)).toBeTruthy();
    // A folder that is not done shows its state, not where it went.
    expect(screen.queryByText('Saved to Photos')).toBeNull();
  });

  it('counts the failed children for a failed folder', () => {
    const r = row({ state: 'failed', direction: 'out' });
    r.children[0] = { ...r.children[0], state: 'failed' };
    r.children[1] = { ...r.children[1], state: 'failed' };
    render(<FolderBubble row={r} savedLine={null} onOpen={jest.fn()} />);
    expect(screen.getByText("Couldn't send 2 of 12")).toBeTruthy();
  });

  it('shows no state line for a done sent folder', () => {
    render(<FolderBubble row={row({ direction: 'out' })} savedLine={null} onOpen={jest.fn()} />);
    expect(screen.queryByText(/Sending|Saved to/)).toBeNull();
  });

  it('has no Retry, even when failed', () => {
    render(<FolderBubble row={row({ state: 'failed', direction: 'out' })} savedLine={null} onOpen={jest.fn()} />);
    expect(screen.queryByText('Retry')).toBeNull();
    expect(screen.queryByLabelText(/Retry/)).toBeNull();
  });

  it('calls onOpen on a press of the bubble and on the Open quick action', () => {
    const onOpen = jest.fn();
    const r = row();
    render(<FolderBubble row={r} savedLine={null} onOpen={onOpen} />);
    fireEvent.press(screen.getByText('album'));
    fireEvent.press(screen.getByLabelText('Open album'));
    expect(screen.getByText('Open')).toBeTruthy();
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenCalledWith(r);
  });

  it('names the folder, the count, the size, and the place for a screen reader', () => {
    render(<FolderBubble row={row()} savedLine="Saved to Photos" onOpen={jest.fn()} />);
    expect(screen.getByLabelText(`Folder album, 12 files, ${SIZE}, saved to Photos`)).toBeTruthy();
  });

  describe('progress', () => {
    const kids = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        threadItem({
          itemIndex: i, type: 'file', text: null, name: `f${i}`, size: 10, state: 'receiving', transferState: 'running',
          group: { name: 'album', rel: `f${i}`, files: n, bytes: BYTES },
        }),
      );
    const running = (n: number, p: Partial<FolderRow> = {}) =>
      row({ files: n, children: kids(n), state: 'receiving', ...p });
    const pctFor = (done: number) => (i: { itemIndex: number }) => (i.itemIndex < done ? 100 : 30);
    const fill = (r: FolderRow) => screen.getByTestId(`bubble-fill-${r.key}`);

    it('folder bubble reads 12 of 40 files and fills 30 percent when 12 children are at 100', () => {
      const r = running(40);
      render(<FolderBubble row={r} savedLine={null} onOpen={jest.fn()} percentOf={pctFor(12)} />);
      expect(screen.getByText('12 of 40 files')).toBeTruthy();
      expect(StyleSheet.flatten(fill(r).props.style).transform).toEqual([{ scaleX: 0.3 }]);
    });

    it('all children in state receiving still count by percent', () => {
      const r = running(10);
      render(<FolderBubble row={r} savedLine={null} onOpen={jest.fn()} percentOf={pctFor(5)} />);
      expect(screen.getByText('5 of 10 files')).toBeTruthy();
      expect(StyleSheet.flatten(fill(r).props.style).transform).toEqual([{ scaleX: 0.5 }]);
    });

    it('a folder with 0 files gives no NaN', () => {
      const r = running(0, { children: [] });
      render(<FolderBubble row={r} savedLine={null} onOpen={jest.fn()} percentOf={() => 100} />);
      expect(screen.queryByTestId(`bubble-fill-${r.key}`)).toBeNull();
      expect(screen.queryByText(/NaN/)).toBeNull();
    });

    it('a done folder draws no fill', () => {
      const r = running(10, { state: 'done' });
      render(<FolderBubble row={r} savedLine="Saved to Photos" onOpen={jest.fn()} percentOf={() => 100} onStopRunning={jest.fn()} />);
      expect(screen.queryByTestId(`bubble-fill-${r.key}`)).toBeNull();
      expect(screen.queryByLabelText('Stop sending')).toBeNull();
    });

    it('a cut child list draws no fill and keeps the old word', () => {
      const r = running(40, { cut: true, children: kids(12) });
      render(<FolderBubble row={r} savedLine={null} onOpen={jest.fn()} percentOf={() => 100} onStopRunning={jest.fn()} />);
      expect(screen.queryByTestId(`bubble-fill-${r.key}`)).toBeNull();
      expect(screen.queryByText(/of 40 files/)).toBeNull();
      expect(screen.getByText('Receiving 0 of 40')).toBeTruthy();
    });

    it('without percentOf the bubble keeps the old word and no fill', () => {
      const r = running(10);
      render(<FolderBubble row={r} savedLine={null} onOpen={jest.fn()} />);
      expect(screen.queryByTestId(`bubble-fill-${r.key}`)).toBeNull();
      expect(screen.getByText('Receiving 0 of 10')).toBeTruthy();
    });

    it('Stop sending shows once on the folder bubble', () => {
      const r = running(10, { direction: 'out', state: 'sending' });
      const stop = jest.fn();
      render(<FolderBubble row={r} savedLine={null} onOpen={jest.fn()} percentOf={pctFor(2)} onStopRunning={stop} />);
      expect(screen.getAllByLabelText('Stop sending')).toHaveLength(1);
      fireEvent.press(screen.getByLabelText('Stop sending'));
      expect(stop).toHaveBeenCalledTimes(1);
    });

    it('a cut running folder still shows Stop', () => {
      const r = running(40, { cut: true, children: kids(12), direction: 'out', state: 'sending' });
      render(<FolderBubble row={r} savedLine={null} onOpen={jest.fn()} percentOf={() => 100} onStopRunning={jest.fn()} />);
      expect(screen.getAllByLabelText('Stop sending')).toHaveLength(1);
    });

    it('a running folder without percentOf still shows Stop', () => {
      const r = running(10, { direction: 'out', state: 'sending' });
      render(<FolderBubble row={r} savedLine={null} onOpen={jest.fn()} onStopRunning={jest.fn()} />);
      expect(screen.getAllByLabelText('Stop sending')).toHaveLength(1);
    });

    it('a stopped folder hides Stop', () => {
      const r = running(10, { direction: 'out', state: 'stopped' });
      render(<FolderBubble row={r} savedLine={null} onOpen={jest.fn()} onStopRunning={jest.fn()} />);
      expect(screen.queryByLabelText('Stop sending')).toBeNull();
    });

    it('the count never exceeds the file total', () => {
      const r = running(12, { files: 10 });
      render(<FolderBubble row={r} savedLine={null} onOpen={jest.fn()} percentOf={() => 100} />);
      expect(screen.getByText('10 of 10 files')).toBeTruthy();
      expect(StyleSheet.flatten(fill(r).props.style).transform).toEqual([{ scaleX: 1 }]);
    });

    it('a failed folder draws its fill in the failed tint', () => {
      const r = running(10, { direction: 'out', state: 'failed' });
      render(<FolderBubble row={r} savedLine={null} onOpen={jest.fn()} percentOf={pctFor(2)} />);
      expect(StyleSheet.flatten(fill(r).props.style).backgroundColor).toBe(colors.errTint);
    });

    it('the label keeps the state word while the fill shows', () => {
      const r = running(40);
      render(<FolderBubble row={r} savedLine={null} onOpen={jest.fn()} percentOf={pctFor(12)} />);
      expect(screen.getByLabelText(`Folder album, 40 files, ${SIZE}, receiving 12 of 40`)).toBeTruthy();
    });

    it('a failed folder hides Stop', () => {
      const r = running(10, { direction: 'out', state: 'failed' });
      render(<FolderBubble row={r} savedLine={null} onOpen={jest.fn()} percentOf={pctFor(2)} onStopRunning={jest.fn()} />);
      expect(screen.queryByLabelText('Stop sending')).toBeNull();
    });
  });
});
