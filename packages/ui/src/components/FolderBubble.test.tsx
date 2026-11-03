import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { humanBytes } from '../screens/quarantine-facts';
import type { FolderRow, FolderState } from '../screens/thread-groups';
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
});
