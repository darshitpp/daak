import React from 'react';
import { Keyboard, KeyboardAvoidingView, ScrollView, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import type { DaakEngine, DaakEvent, DeviceInfo, TransferSummary } from '@daak/core';
import { EngineProvider } from '../EngineContext';
import { fakeEngine } from '../testing/fakeEngine';
import { threadItem, threadPage } from '../testing/threadFixtures';
import { ToastProvider } from '../components/Toast';
import { Note } from '../components/ds';
import { ThreadScreen, splitExt, type MediaRef } from './ThreadScreen';
import type { BatchRowStatus } from './ThreadScreen';
import * as progressModule from '../state/progress';

const peer: DeviceInfo = {
  deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '', online: true, presence: 'online', paired: true,
};
const TID = 'bb'.repeat(16);

const emit = (engine: DaakEngine, e: DaakEvent) =>
  act(() => {
    (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers.forEach((h) => h(e));
  });
const settle = (ms = 30) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

function mount(engine: DaakEngine, props: Partial<React.ComponentProps<typeof ThreadScreen>> = {}) {
  const onBack = jest.fn();
  const utils = render(
    <EngineProvider engine={engine}>
      <ToastProvider>
        <ThreadScreen peerDeviceId={peer.deviceId} onBack={onBack} {...props} />
      </ToastProvider>
    </EngineProvider>,
  );
  return { onBack, ...utils };
}

const summary = (p: Partial<TransferSummary> = {}): TransferSummary => ({
  transferId: TID, peerDeviceId: peer.deviceId, direction: 'out', kind: 'media', state: 'active',
  bytesDone: 0, bytesTotal: 134_217_728, itemCount: 3, updatedAt: 1, ...p,
});

describe('ThreadScreen', () => {
  // A load that is still pending when a test ends must finish inside act.
  afterEach(async () => { await settle(0); });

  // Review Focus 1.
  it('shows the empty state and keeps the composer when the thread has no items', async () => {
    mount(fakeEngine([peer]));
    expect(await screen.findByText('Nothing here yet')).toBeTruthy();
    // Design v2 `#cd-empty`: exact words, and "this device" in place of the name.
    expect(screen.getByText('Send the first file or note with the buttons below. It travels straight to this device over your Wi-Fi.')).toBeTruthy();
    expect(screen.getByPlaceholderText('Or type a note')).toBeTruthy();
  });

  it('shows the device name and its presence word in the header', async () => {
    mount(fakeEngine([{ ...peer, presence: 'away' }]));
    expect(await screen.findByText('Pixel 9')).toBeTruthy();
    expect(screen.getByText('Away')).toBeTruthy();
  });

  // The engine cut the item list of one send. The note shows once, after the
  // last kept item of that send, and not after a send that is whole.
  it('says once that some items of a cut send are not shown', async () => {
    const engine = fakeEngine([peer]);
    const CUT = 'dd'.repeat(16);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([
      threadItem({ transferId: CUT, itemIndex: 0, text: 'one', truncated: true }),
      threadItem({ transferId: CUT, itemIndex: 1, text: 'two', truncated: true }),
      threadItem({ transferId: 'cc'.repeat(16), itemIndex: 0, text: 'whole send' }),
    ]));
    mount(engine);
    expect(await screen.findByText('whole send')).toBeTruthy();
    expect(screen.getAllByText('Some items of this send are not shown.')).toHaveLength(1);
  });

  it('shows no cut note when no item is cut', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([threadItem({ text: 'plain' })]));
    mount(engine);
    expect(await screen.findByText('plain')).toBeTruthy();
    expect(screen.queryByText('Some items of this send are not shown.')).toBeNull();
  });

  it('renders the history oldest first with text, file, and time', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([
      threadItem({ text: 'first note', itemIndex: 0 }),
      threadItem({ transferId: 'cc'.repeat(16), type: 'file', text: null, name: 'beach.mov', size: 118_000_000, destPath: '/d/beach.mov' }),
    ]));
    mount(engine);
    expect(await screen.findByText('first note')).toBeTruthy();
    expect(screen.getByText('beach.mov')).toBeTruthy();
  });

  it('disables Send until there is a file or a non-blank note', async () => {
    mount(fakeEngine([peer]), { onPickFiles: async () => ['/Users/d/a.pdf'] });
    await screen.findByText('Nothing here yet');
    expect(screen.getByTestId('send')).toBeDisabled();
    fireEvent.changeText(screen.getByPlaceholderText('Or type a note'), '   ');
    expect(screen.getByTestId('send')).toBeDisabled();
    fireEvent.changeText(screen.getByPlaceholderText('Or type a note'), 'hi');
    expect(screen.getByTestId('send')).not.toBeDisabled();
  });

  it('shows a chip for each picked file and removes it on press', async () => {
    mount(fakeEngine([peer]), { onPickFiles: async () => ['/Users/d/a.pdf', '/Users/d/b.png'] });
    await screen.findByText('Nothing here yet');
    fireEvent.press(screen.getByTestId('pick-files'));
    expect(await screen.findByText('a.pdf')).toBeTruthy();
    // The count comes as the design toast, not as a line in the composer.
    expect(screen.getByTestId('toast-text')).toHaveTextContent('2 files ready');
    fireEvent.press(screen.getByTestId('remove-a.pdf'));
    expect(screen.queryByText('a.pdf')).toBeNull();
    expect(screen.getByText('b.png')).toBeTruthy();
  });

  const many = (n: number) => Array.from({ length: n }, (_, i) => `/Users/d/f${i}.pdf`);

  it('folds more than 3 files into one summary chip and keeps Send on the screen', async () => {
    mount(fakeEngine([peer]), { initialFiles: many(40) });
    expect(await screen.findByText('40 files · Review')).toBeTruthy();
    expect(screen.queryByTestId('remove-f0.pdf')).toBeNull();
    expect(screen.getByTestId('send')).not.toBeDisabled();
  });

  it('keeps one chip for each file at 3 files or fewer', async () => {
    mount(fakeEngine([peer]), { initialFiles: many(3) });
    expect(await screen.findByTestId('remove-f2.pdf')).toBeTruthy();
    expect(screen.queryByTestId('files-review')).toBeNull();
  });

  it('opens the review sheet and lowers the count when a file is removed', async () => {
    mount(fakeEngine([peer]), { initialFiles: many(40) });
    fireEvent.press(await screen.findByTestId('files-review'));
    expect(screen.getByText('40 files')).toBeTruthy();
    fireEvent.press(screen.getByTestId('review-remove-f0.pdf'));
    expect(screen.getByText('39 files')).toBeTruthy();
    expect(screen.getByText('39 files · Review')).toBeTruthy();
    expect(screen.queryByTestId('review-remove-f0.pdf')).toBeNull();
  });

  it('keeps the sheet open at 3 files and closes it on Done', async () => {
    mount(fakeEngine([peer]), { initialFiles: many(4) });
    fireEvent.press(await screen.findByTestId('files-review'));
    fireEvent.press(screen.getByTestId('review-remove-f0.pdf'));
    // The sheet is open and the composer shows one chip for each file again.
    expect(screen.getByTestId('files-review-done')).toBeTruthy();
    expect(screen.getByTestId('remove-f1.pdf')).toBeTruthy();
    expect(screen.getByTestId('review-remove-f1.pdf')).toBeTruthy();
    fireEvent.press(screen.getByTestId('files-review-done'));
    expect(screen.queryByTestId('files-review-done')).toBeNull();
  });

  it('closes the sheet when the last file is removed', async () => {
    mount(fakeEngine([peer]), { initialFiles: many(4) });
    fireEvent.press(await screen.findByTestId('files-review'));
    for (let i = 0; i < 4; i++) fireEvent.press(screen.getByTestId(`review-remove-f${i}.pdf`));
    expect(screen.queryByTestId('files-review-done')).toBeNull();
    expect(screen.queryByTestId('files-review')).toBeNull();
  });

  it('renders both rows for two files with the same base name and removes only one path', async () => {
    mount(fakeEngine([peer]), {
      initialFiles: ['/a/same.pdf', '/b/same.pdf', '/c/x.pdf', '/d/y.pdf'],
    });
    fireEvent.press(await screen.findByTestId('files-review'));
    expect(screen.getAllByTestId('review-remove-same.pdf')).toHaveLength(2);
    fireEvent.press(screen.getAllByTestId('review-remove-same.pdf')[0]);
    expect(screen.getAllByTestId('review-remove-same.pdf')).toHaveLength(1);
    expect(screen.getByText('3 files')).toBeTruthy();
  });

  it('shows each size and the total when every size is known', async () => {
    const fileSizes = jest.fn(async (p: string[]) => p.map(() => 2048));
    mount(fakeEngine([peer]), { initialFiles: many(4), actions: { fileSizes } });
    fireEvent.press(await screen.findByTestId('files-review'));
    // 4 files of 2048 bytes: 8192 bytes is 8.0 KB.
    expect(await screen.findByText('4 files · 8.0 KB')).toBeTruthy();
    expect(screen.getAllByText('2.0 KB')).toHaveLength(4);
    expect(fileSizes).toHaveBeenCalledTimes(1);
    expect(fileSizes).toHaveBeenCalledWith(many(4));
  });

  it('shows the name only and no total when one size is unknown', async () => {
    const fileSizes = jest.fn(async (p: string[]) => p.map((_, i) => (i === 1 ? null : 1024)));
    mount(fakeEngine([peer]), { initialFiles: many(4), actions: { fileSizes } });
    fireEvent.press(await screen.findByTestId('files-review'));
    await waitFor(() => expect(fileSizes).toHaveBeenCalled());
    await settle();
    expect(screen.getByText('4 files')).toBeTruthy();
    expect(screen.getAllByText('1.0 KB')).toHaveLength(3);
  });

  it('shows names only and no error when fileSizes rejects', async () => {
    const fileSizes = jest.fn(async () => { throw new Error('E_FSPATHS'); });
    mount(fakeEngine([peer]), { initialFiles: many(4), actions: { fileSizes } });
    fireEvent.press(await screen.findByTestId('files-review'));
    await waitFor(() => expect(fileSizes).toHaveBeenCalled());
    await settle();
    expect(screen.getByText('4 files')).toBeTruthy();
    expect(screen.getByTestId('review-remove-f0.pdf')).toBeTruthy();
  });

  it('shows names only when the host has no fileSizes verb', async () => {
    mount(fakeEngine([peer]), { initialFiles: many(4) });
    fireEvent.press(await screen.findByTestId('files-review'));
    expect(screen.getByText('4 files')).toBeTruthy();
  });

  it('asks for the size of a file added while the sheet is open', async () => {
    const fileSizes = jest.fn(async (p: string[]) => p.map(() => 1024));
    mount(fakeEngine([peer]), {
      initialFiles: many(4),
      actions: { fileSizes },
      onPickFiles: async () => ['/Users/d/late.pdf'],
    });
    fireEvent.press(await screen.findByTestId('files-review'));
    await screen.findByText('4 files · 4.0 KB');
    fireEvent.press(screen.getByTestId('pick-files'));
    await screen.findByText('5 files · 5.0 KB');
    expect(fileSizes).toHaveBeenLastCalledWith(['/Users/d/late.pdf']);
  });

  it('ignores a stale size answer after the user removed a file', async () => {
    // Each call keeps its own resolver. The removal makes the first call stale.
    const resolvers: ((v: number[]) => void)[] = [];
    const fileSizes = jest.fn(() => new Promise<number[]>((r) => { resolvers.push(r); }));
    mount(fakeEngine([peer]), { initialFiles: many(4), actions: { fileSizes } });
    fireEvent.press(await screen.findByTestId('files-review'));
    await waitFor(() => expect(fileSizes).toHaveBeenCalledTimes(1));
    fireEvent.press(screen.getByTestId('review-remove-f0.pdf'));
    await waitFor(() => expect(fileSizes).toHaveBeenCalledTimes(2));
    // The stale answer (4 paths) arrives first. It must change nothing.
    await act(async () => { resolvers[0]([1024, 1024, 1024, 1024]); });
    expect(screen.getByText('3 files')).toBeTruthy();
    // The current answer (3 paths) gives the total.
    await act(async () => { resolvers[1]([1024, 1024, 1024]); });
    expect(await screen.findByText('3 files · 3.0 KB')).toBeTruthy();
  });

  it('does not reopen the sheet when files are staged again after the last one was removed', async () => {
    mount(fakeEngine([peer]), { initialFiles: many(4), onPickFiles: async () => many(4) });
    fireEvent.press(await screen.findByTestId('files-review'));
    for (let i = 0; i < 4; i++) fireEvent.press(screen.getByTestId(`review-remove-f${i}.pdf`));
    expect(screen.queryByTestId('files-review-done')).toBeNull();
    fireEvent.press(screen.getByTestId('pick-files'));
    expect(await screen.findByTestId('files-review')).toBeTruthy();
    expect(screen.queryByTestId('files-review-done')).toBeNull();
  });

  it('dismisses the keyboard when the summary chip opens the sheet', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    mount(fakeEngine([peer]), { initialFiles: many(4) });
    fireEvent.press(await screen.findByTestId('files-review'));
    expect(dismiss).toHaveBeenCalledTimes(1);
    dismiss.mockRestore();
  });

  it('splits a file name at the last dot', () => {
    expect(splitExt('a.pdf')).toEqual(['a', '.pdf']);
    expect(splitExt('noext')).toEqual(['noext', '']);
    expect(splitExt('.hidden')).toEqual(['.hidden', '']);
    expect(splitExt('a.tar.gz')).toEqual(['a.tar', '.gz']);
  });

  it('asks for sizes again when a sent path is staged again', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'send').mockResolvedValue({ transferId: TID, queued: true });
    const fileSizes = jest.fn(async (p: string[]) => p.map(() => 1024));
    mount(engine, { initialFiles: many(4), actions: { fileSizes }, onPickFiles: async () => many(4) });
    fireEvent.press(await screen.findByTestId('files-review'));
    await screen.findByText('4 files · 4.0 KB');
    fireEvent.press(screen.getByTestId('files-review-done'));
    fireEvent.press(screen.getByTestId('send'));
    await screen.findByText('Sent to Pixel 9');
    fireEvent.press(screen.getByTestId('pick-files'));
    fireEvent.press(await screen.findByTestId('files-review'));
    await waitFor(() => expect(fileSizes).toHaveBeenCalledTimes(2));
    expect(fileSizes).toHaveBeenLastCalledWith(many(4));
  });

  it('toasts "1 file ready" for a single picked file', async () => {
    mount(fakeEngine([peer]), { onPickFiles: async () => ['/Users/d/a.pdf'] });
    await screen.findByText('Nothing here yet');
    fireEvent.press(screen.getByTestId('pick-files'));
    expect(await screen.findByText('1 file ready')).toBeTruthy();
  });

  it('shows no files-ready toast for files that a link or a share seeded', async () => {
    mount(fakeEngine([peer]), { initialFiles: ['/Documents/photo.png'] });
    expect(await screen.findByText('photo.png')).toBeTruthy();
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('draws no Add files button when the host gives no picker', async () => {
    mount(fakeEngine([peer]));
    await screen.findByText('Nothing here yet');
    expect(screen.queryByTestId('pick-files')).toBeNull();
  });

  // Spec 6.3 rule 4: two transfers, files first.
  it('sends the files first and the note second, as two sends', async () => {
    const engine = fakeEngine([peer]);
    const send = jest.spyOn(engine, 'send').mockResolvedValue({ transferId: TID, queued: true });
    mount(engine, { onPickFiles: async () => ['/Users/d/a.pdf'] });
    await screen.findByText('Nothing here yet');
    fireEvent.press(screen.getByTestId('pick-files'));
    await screen.findByText('a.pdf');
    fireEvent.changeText(screen.getByPlaceholderText('Or type a note'), 'here you go');
    fireEvent.press(screen.getByTestId('send'));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenNthCalledWith(1, { peerDeviceId: peer.deviceId, files: ['/Users/d/a.pdf'] });
    expect(send).toHaveBeenNthCalledWith(2, { peerDeviceId: peer.deviceId, text: 'here you go' });
    expect(await screen.findByText('Sent to Pixel 9')).toBeTruthy();
    // A success is a toast. It is not a result note.
    expect(screen.getByTestId('toast')).toBeTruthy();
    expect(screen.queryByTestId('thread-result')).toBeNull();
    expect(screen.getByPlaceholderText('Or type a note').props.value).toBe('');
    expect(screen.queryByText('a.pdf')).toBeNull();
  });

  it('sends only the note when there are no files', async () => {
    const engine = fakeEngine([peer]);
    const send = jest.spyOn(engine, 'send').mockResolvedValue({ transferId: TID, queued: true });
    mount(engine);
    await screen.findByText('Nothing here yet');
    fireEvent.changeText(screen.getByPlaceholderText('Or type a note'), '  hello  ');
    fireEvent.press(screen.getByTestId('send'));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith({ peerDeviceId: peer.deviceId, text: 'hello' });
  });

  // `InProcessEngine.send` returns queued: true for every send, so the words
  // must come from the presence of the peer.
  it('says Sent to for an online peer even when the engine reports queued: true', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'send').mockResolvedValue({ transferId: TID, queued: true });
    mount(engine);
    await screen.findByText('Nothing here yet');
    fireEvent.changeText(screen.getByPlaceholderText('Or type a note'), 'now');
    fireEvent.press(screen.getByTestId('send'));
    expect(await screen.findByText('Sent to Pixel 9')).toBeTruthy();
    expect(screen.queryByText('Will send when Pixel 9 is back')).toBeNull();
  });

  // Review Focus 3.
  it('says the send will wait when the peer is offline', async () => {
    const off = { ...peer, presence: 'offline' as const, online: false };
    const engine = fakeEngine([off]);
    jest.spyOn(engine, 'send').mockResolvedValue({ transferId: TID, queued: true });
    mount(engine);
    expect(await screen.findByText('Not on this network')).toBeTruthy();
    fireEvent.changeText(screen.getByPlaceholderText('Or type a note'), 'later');
    expect(screen.getByTestId('send')).not.toBeDisabled();
    fireEvent.press(screen.getByTestId('send'));
    expect(await screen.findByText('Will send when Pixel 9 is back')).toBeTruthy();
    expect(screen.queryByTestId('thread-result')).toBeNull();
  });

  it('keeps the error note and shows no toast when the send fails', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'send').mockRejectedValue(new Error('peer refused'));
    mount(engine);
    await screen.findByText('Nothing here yet');
    fireEvent.changeText(screen.getByPlaceholderText('Or type a note'), 'x');
    fireEvent.press(screen.getByTestId('send'));
    expect(await screen.findByTestId('thread-result')).toBeTruthy();
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('works with no ToastProvider above it', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'send').mockResolvedValue({ transferId: TID, queued: true });
    render(
      <EngineProvider engine={engine}>
        <ThreadScreen peerDeviceId={peer.deviceId} onBack={jest.fn()} />
      </EngineProvider>,
    );
    await screen.findByText('Nothing here yet');
    fireEvent.changeText(screen.getByPlaceholderText('Or type a note'), 'hi');
    fireEvent.press(screen.getByTestId('send'));
    await waitFor(() => expect(engine.send).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('keeps the note and shows the engine error when the note send fails after the files went', async () => {
    const engine = fakeEngine([peer]);
    const send = jest.spyOn(engine, 'send')
      .mockResolvedValueOnce({ transferId: TID, queued: true })
      .mockRejectedValueOnce(new Error('peer refused'));
    mount(engine, { onPickFiles: async () => ['/Users/d/a.pdf'] });
    await screen.findByText('Nothing here yet');
    fireEvent.press(screen.getByTestId('pick-files'));
    await screen.findByText('a.pdf');
    fireEvent.changeText(screen.getByPlaceholderText('Or type a note'), 'keep me');
    fireEvent.press(screen.getByTestId('send'));
    expect(await screen.findByText('That send did not go through')).toBeTruthy();
    expect(screen.getByText('peer refused')).toBeTruthy();
    expect(screen.queryByText('a.pdf')).toBeNull();
    expect(screen.getByPlaceholderText('Or type a note').props.value).toBe('keep me');
    // Try again sends only the note.
    send.mockResolvedValueOnce({ transferId: TID, queued: true });
    fireEvent.press(screen.getByTestId('thread-retry-send'));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send).toHaveBeenLastCalledWith({ peerDeviceId: peer.deviceId, text: 'keep me' });
  });

  it('seeds the composer from a link or a share', async () => {
    mount(fakeEngine([peer]), { initialText: 'from a link', initialFiles: ['/Documents/photo.png'] });
    expect(await screen.findByDisplayValue('from a link')).toBeTruthy();
    expect(screen.getByText('photo.png')).toBeTruthy();
  });

  // Review Focus 5.
  it('refetches once for ten events in one frame', async () => {
    const engine = fakeEngine([peer]);
    const spy = jest.spyOn(engine, 'listThread');
    mount(engine);
    await screen.findByText('Nothing here yet');
    expect(spy).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i += 1) emit(engine, { type: 'transfer.item', transferId: TID, itemIndex: i, state: 'done' });
    await settle();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('refetches on each listed event type', async () => {
    const engine = fakeEngine([peer]);
    const spy = jest.spyOn(engine, 'listThread');
    mount(engine);
    await screen.findByText('Nothing here yet');
    const events: DaakEvent[] = [
      { type: 'transfer.done', transferId: TID },
      { type: 'transfer.failed', transferId: TID, error: 'x' },
      { type: 'outbox.queued', deviceId: peer.deviceId, queued: 1 },
      { type: 'device.presence', deviceId: peer.deviceId, presence: 'away' },
    ];
    for (const e of events) {
      const before = spy.mock.calls.length;
      emit(engine, e);
      await settle();
      expect(spy.mock.calls.length).toBe(before + 1);
    }
  });

  it('drops a slow older response that arrives after a newer one', async () => {
    const engine = fakeEngine([peer]);
    let releaseSlow!: () => void;
    const slow = new Promise<void>((r) => { releaseSlow = r; });
    const spy = jest.spyOn(engine, 'listThread');
    spy.mockResolvedValueOnce(threadPage([]));
    mount(engine);
    await screen.findByText('Nothing here yet');
    spy.mockImplementationOnce(async () => { await slow; return threadPage([threadItem({ text: 'OLD' })]); });
    spy.mockResolvedValueOnce(threadPage([threadItem({ text: 'NEW' })]));
    emit(engine, { type: 'transfer.done', transferId: TID });
    await settle();
    emit(engine, { type: 'transfer.done', transferId: TID });
    await settle();
    expect(await screen.findByText('NEW')).toBeTruthy();
    await act(async () => { releaseSlow(); });
    await settle();
    expect(screen.queryByText('OLD')).toBeNull();
    expect(screen.getByText('NEW')).toBeTruthy();
  });

  it('loads an older page and keeps the cursor chain', async () => {
    const engine = fakeEngine([peer]);
    const spy = jest.spyOn(engine, 'listThread');
    spy.mockResolvedValueOnce(threadPage([threadItem({ text: 'newer', at: 200 })], 'c1'));
    mount(engine);
    await screen.findByText('newer');
    spy.mockResolvedValueOnce(threadPage([threadItem({ transferId: 'cc'.repeat(16), text: 'older', at: 100 })], null));
    fireEvent.press(screen.getByTestId('thread-load-older'));
    expect(await screen.findByText('older')).toBeTruthy();
    expect(spy).toHaveBeenLastCalledWith(peer.deviceId, { limit: 50, before: 'c1' });
    expect(screen.queryByTestId('thread-load-older')).toBeNull();
  });

  it('shows an error with Try again when the thread read fails', async () => {
    const engine = fakeEngine([peer]);
    const spy = jest.spyOn(engine, 'listThread').mockRejectedValueOnce(new Error('engine not started'));
    mount(engine);
    expect(await screen.findByText('engine not started')).toBeTruthy();
    spy.mockResolvedValueOnce(threadPage([threadItem({ text: 'back' })]));
    fireEvent.press(screen.getByTestId('thread-reload'));
    expect(await screen.findByText('back')).toBeTruthy();
  });

  // The anchor that keeps the reader's place exists only when an older page
  // added items. An empty page must leave no stale anchor.
  it('leaves no anchor after an empty older page, so a new item scrolls to the end', async () => {
    const engine = fakeEngine([peer]);
    const spy = jest.spyOn(engine, 'listThread');
    spy.mockResolvedValueOnce(threadPage([threadItem({ text: 'newer', at: 200 })], 'c1'));
    mount(engine);
    await screen.findByText('newer');
    const sv = screen.UNSAFE_getByType(ScrollView);
    const toEnd = jest.spyOn(sv.instance, 'scrollToEnd');
    const to = jest.spyOn(sv.instance, 'scrollTo');
    fireEvent(sv, 'contentSizeChange', 300, 1000);
    // The reader sits at the bottom of a 1000 point list.
    fireEvent.scroll(sv, {
      nativeEvent: { contentOffset: { x: 0, y: 600 }, contentSize: { width: 300, height: 1000 }, layoutMeasurement: { width: 300, height: 400 } },
    });
    spy.mockResolvedValueOnce(threadPage([], null));
    fireEvent.press(screen.getByTestId('thread-load-older'));
    // 1 s is the default and this file runs beside 36 others in the gate. The
    // assertion is unchanged; only the wait is longer.
    await waitFor(() => expect(screen.queryByTestId('thread-load-older')).toBeNull(), { timeout: 5000 });
    toEnd.mockClear();
    to.mockClear();
    spy.mockResolvedValueOnce(threadPage([
      threadItem({ text: 'newer', at: 200 }),
      threadItem({ transferId: 'cc'.repeat(16), text: 'brand new', at: 300 }),
    ], null));
    emit(engine, { type: 'transfer.done', transferId: TID });
    await settle();
    await screen.findByText('brand new');
    fireEvent(sv, 'contentSizeChange', 300, 1100);
    expect(to).not.toHaveBeenCalled();
    expect(toEnd).toHaveBeenCalled();
  });

  // ui has no platform check, so the host asks for the keyboard wrapper.
  it('wraps the composer in a KeyboardAvoidingView only when the host asks', async () => {
    const first = mount(fakeEngine([peer]));
    await screen.findByText('Nothing here yet');
    expect(screen.queryByTestId('thread-keyboard-avoiding')).toBeNull();
    first.unmount();
    mount(fakeEngine([peer]), { keyboardAvoiding: true });
    expect(await screen.findByTestId('thread-keyboard-avoiding')).toBeTruthy();
    expect(screen.UNSAFE_getByType(KeyboardAvoidingView).props.behavior).toBe('padding');
    expect(screen.getByPlaceholderText('Or type a note')).toBeTruthy();
  });

  // Active transfer card.
  it('shows the active card, stops after a confirm, and calls cancel', async () => {
    const engine = fakeEngine([peer]);
    const list = jest.spyOn(engine, 'listTransfers').mockResolvedValue([summary({ bytesDone: 67_108_864 })]);
    const cancel = jest.spyOn(engine, 'cancel').mockResolvedValue();
    mount(engine, { deviceNoun: 'Mac' });
    expect(await screen.findByText('Sending to Pixel 9')).toBeTruthy();
    // The read is narrowed to the active transfers of this peer.
    expect(list).toHaveBeenCalledWith({ peerDeviceId: peer.deviceId, state: 'active' });
    expect(screen.getByText('3 items · 128.0 MB')).toBeTruthy();
    expect(screen.getByText('Sending over your Wi-Fi')).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
    fireEvent.press(screen.getByTestId('thread-stop-' + TID));
    expect(screen.getByText('Stop sending?')).toBeTruthy();
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('confirm-stop'));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(TID));
    // The design toast after a confirmed stop.
    expect(await screen.findByText('Sending stopped')).toBeTruthy();
  });

  it('keeps an error note and shows no toast when the engine refuses the stop', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([summary()]);
    jest.spyOn(engine, 'cancel').mockRejectedValue(new Error('too late'));
    mount(engine);
    fireEvent.press(await screen.findByTestId('thread-stop-' + TID));
    fireEvent.press(screen.getByTestId('confirm-stop'));
    expect(await screen.findByText('Sending did not stop')).toBeTruthy();
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('keeps sending when the user picks Keep sending', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([summary()]);
    const cancel = jest.spyOn(engine, 'cancel').mockResolvedValue();
    mount(engine);
    fireEvent.press(await screen.findByTestId('thread-stop-' + TID));
    fireEvent.press(screen.getByTestId('keep-sending'));
    expect(cancel).not.toHaveBeenCalled();
  });

  // Design #cd-transfer-stop: the stop sheet names the peer and this device.
  it('names the peer and this device in the stop sheet body', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([summary()]);
    const first = mount(engine, { deviceNoun: 'Mac' });
    fireEvent.press(await screen.findByTestId('thread-stop-' + TID));
    expect(
      screen.getByText('Nothing has reached Pixel 9 yet. If you stop now, the items stay on this Mac.'),
    ).toBeTruthy();
    first.unmount();
    mount(engine, { deviceNoun: 'phone' });
    fireEvent.press(await screen.findByTestId('thread-stop-' + TID));
    expect(
      screen.getByText('Nothing has reached Pixel 9 yet. If you stop now, the items stay on this phone.'),
    ).toBeTruthy();
  });

  // Correction 2: the engine emits no progress, so 0 bytes must not read as 0%.
  it('shows no percentage while no byte count is known', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([summary({ bytesDone: 0 })]);
    mount(engine);
    await screen.findByText('Sending to Pixel 9');
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('follows transfer.progress events for the card', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([summary()]);
    mount(engine);
    await screen.findByText('Sending to Pixel 9');
    emit(engine, { type: 'transfer.progress', transferId: TID, bytesDone: 33_554_432, bytesTotal: 134_217_728 });
    expect(await screen.findByText('25%')).toBeTruthy();
  });

  // Task 6. The hook reads Date.now. The test moves the clock by hand.
  it('thread_row_shows_speed_while_active', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([summary()]);
    const MIB = 1024 * 1024;
    let now = 1_000_000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      mount(engine);
      await screen.findByText('Sending to Pixel 9');
      for (let i = 1; i <= 5; i++) {
        now += 500;
        emit(engine, { type: 'transfer.progress', transferId: TID, bytesDone: i * 5 * MIB, bytesTotal: 128 * MIB });
      }
      expect(await screen.findByText(/MiB\/s/)).toBeTruthy();
    } finally {
      clock.mockRestore();
    }
  });

  it('thread_row_hides_speed_when_done_or_failed', async () => {
    const MIB = 1024 * 1024;
    for (const state of ['done', 'failed'] as const) {
      const engine = fakeEngine([peer]);
      const list = jest.spyOn(engine, 'listTransfers').mockResolvedValue([summary()]);
      let now = 1_000_000;
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const view = mount(engine);
        await screen.findByText('Sending to Pixel 9');
        for (let i = 1; i <= 5; i++) {
          now += 500;
          emit(engine, { type: 'transfer.progress', transferId: TID, bytesDone: i * 5 * MIB, bytesTotal: 128 * MIB });
        }
        await screen.findByText(/MiB\/s/);
        // The engine now lists no active transfer. The card goes away.
        list.mockResolvedValue([summary({ state })]);
        emit(engine, { type: 'transfer.done', transferId: TID } as DaakEvent);
        await waitFor(() => expect(screen.queryByTestId('thread-active-' + TID)).toBeNull());
        expect(screen.queryByText(/MiB\/s/)).toBeNull();
        view.unmount();
      } finally {
        clock.mockRestore();
      }
    }
  });

  // Design: the Stop action on a queued bubble needs no confirm sheet.
  it('shows a queued outbound item as Waiting to send and stops it with no sheet', async () => {
    const engine = fakeEngine([{ ...peer, presence: 'offline', online: false }]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([
      threadItem({ direction: 'out', type: 'file', text: null, name: 'a.pdf', size: 10, state: 'pending', transferState: 'queued', transferId: TID }),
    ]));
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([summary({ state: 'queued' })]);
    const cancel = jest.spyOn(engine, 'cancel').mockResolvedValue();
    mount(engine);
    expect(await screen.findByText('Waiting to send')).toBeTruthy();
    // A queued transfer is a waiting bubble. It is not an active card.
    expect(screen.queryByTestId('thread-active-' + TID)).toBeNull();
    fireEvent.press(screen.getByLabelText('Stop waiting to send a.pdf'));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(TID));
    expect(screen.queryByText('Stop sending?')).toBeNull();
    // The design toast "Stopped".
    expect(await screen.findByText('Stopped')).toBeTruthy();
    expect(screen.getByTestId('toast-text')).toHaveTextContent('Stopped');
    expect(screen.queryByTestId('thread-result')).toBeNull();
  });

  it('retries a failed outbound item with engine.retry', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([
      threadItem({ direction: 'out', type: 'file', text: null, name: 'a.pdf', state: 'failed', transferState: 'failed', error: 'timed out', transferId: TID }),
    ]));
    const retry = jest.spyOn(engine, 'retry').mockResolvedValue();
    mount(engine);
    fireEvent.press(await screen.findByLabelText('Retry sending a.pdf'));
    await waitFor(() => expect(retry).toHaveBeenCalledWith(TID));
    // The app shows "Sent to {name}" after a Retry.
    expect(await screen.findByText('Sent to Pixel 9')).toBeTruthy();
  });

  // Review Focus 7.
  it('routes a held-back bubble to the held route with its ids', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([
      threadItem({ type: 'file', text: null, name: 'bad.jpg', state: 'quarantined', transferId: TID, itemIndex: 2 }),
    ]));
    const onOpenHeld = jest.fn();
    mount(engine, { onOpenHeld });
    // Design v2: the held bubble offers Review, which opens the held route.
    fireEvent.press(await screen.findByLabelText('Review bad.jpg'));
    expect(onOpenHeld).toHaveBeenCalledWith({ transferId: TID, itemIndex: 2 });
  });

  // P7: a text that the engine cut copies the WHOLE text, not the cut part.
  it('copies the whole text from getItemText when the page cut the text', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([
      threadItem({ text: 'start of a long note', textTruncated: true, itemIndex: 4 }),
    ]));
    const whole = jest.spyOn(engine, 'getItemText').mockResolvedValue('start of a long note and all the rest');
    const actions = { copy: jest.fn() };
    mount(engine, { actions });
    fireEvent.press(await screen.findByLabelText('Copy text'));
    expect(await screen.findByText('Copied')).toBeTruthy();
    expect(whole).toHaveBeenCalledWith(TID, 4);
    expect(actions.copy).toHaveBeenCalledWith('start of a long note and all the rest');
  });

  it('copies nothing and says so when the whole text cannot be fetched', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([
      threadItem({ text: 'start', textTruncated: true }),
    ]));
    jest.spyOn(engine, 'getItemText').mockRejectedValue(new Error('too long'));
    const actions = { copy: jest.fn() };
    mount(engine, { actions });
    fireEvent.press(await screen.findByLabelText('Copy text'));
    expect(await screen.findByText('Could not copy the whole text.')).toBeTruthy();
    expect(actions.copy).not.toHaveBeenCalled();
    expect(screen.queryByText('Copied')).toBeNull();
  });

  it('copies the page text and does not call getItemText for a text that was not cut', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([threadItem({ text: 'short note' })]));
    const whole = jest.spyOn(engine, 'getItemText');
    const actions = { copy: jest.fn() };
    mount(engine, { actions });
    fireEvent.press(await screen.findByLabelText('Copy text'));
    expect(actions.copy).toHaveBeenCalledWith('short note');
    expect(whole).not.toHaveBeenCalled();
  });

  // Host verbs.
  it('wires Copy, Preview, and Share to the host verbs', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([
      threadItem({ text: 'copy me' }),
      threadItem({ transferId: 'cc'.repeat(16), type: 'file', text: null, name: 'r.pdf', destPath: '/d/r.pdf' }),
    ]));
    const actions = { copy: jest.fn(), open: jest.fn(async () => true), share: jest.fn() };
    mount(engine, { actions });
    fireEvent.press(await screen.findByLabelText('Copy text'));
    expect(actions.copy).toHaveBeenCalledWith('copy me');
    // The design toast "Copied".
    expect(await screen.findByText('Copied')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Preview r.pdf'));
    expect(actions.open).toHaveBeenCalledWith('/d/r.pdf');
    fireEvent.press(screen.getByLabelText('Share r.pdf'));
    expect(actions.share).toHaveBeenCalledWith(['/d/r.pdf']);
  });

  it('hides Share for a row whose path the host refuses', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([
      threadItem({ transferId: 'cc'.repeat(16), type: 'file', text: null, name: 'r.pdf', destPath: 'photos:ABC' }),
    ]));
    const actions = { open: jest.fn(async () => true), share: jest.fn(), canShare: (p: string) => !p.startsWith('photos:') };
    mount(engine, { actions });
    await screen.findByLabelText('Preview r.pdf');
    expect(screen.queryByLabelText('Share r.pdf')).toBeNull();
  });

  it('keeps Share for a row the host accepts', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([
      threadItem({ transferId: 'cc'.repeat(16), type: 'file', text: null, name: 'r.pdf', destPath: '/app/a.pdf' }),
    ]));
    const actions = { open: jest.fn(async () => true), share: jest.fn(), canShare: (p: string) => !p.startsWith('photos:') };
    mount(engine, { actions });
    await screen.findByLabelText('Preview r.pdf');
    expect(screen.getByLabelText('Share r.pdf')).toBeTruthy();
  });

  it('keeps Share when the host gives no canShare', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([
      threadItem({ transferId: 'cc'.repeat(16), type: 'file', text: null, name: 'r.pdf', destPath: 'photos:ABC' }),
    ]));
    const actions = { open: jest.fn(async () => true), share: jest.fn() };
    mount(engine, { actions });
    await screen.findByLabelText('Preview r.pdf');
    expect(screen.getByLabelText('Share r.pdf')).toBeTruthy();
  });

  it('draws no verb the host does not supply', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([
      threadItem({ text: 'x' }),
      threadItem({ transferId: 'cc'.repeat(16), type: 'file', text: null, name: 'r.pdf', destPath: '/d/r.pdf' }),
    ]));
    mount(engine, { actions: {} });
    await screen.findByText('x');
    expect(screen.queryByLabelText('Copy text')).toBeNull();
    expect(screen.queryByLabelText('Preview r.pdf')).toBeNull();
    expect(screen.queryByLabelText('Share r.pdf')).toBeNull();
  });

  // Ruling: a Preview that no app can open is a toast, not a note.
  it('toasts when the host could not open the file', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([
      threadItem({ type: 'file', text: null, name: 'r.pdf', destPath: '/d/r.pdf' }),
    ]));
    mount(engine, { actions: { open: async () => false } });
    fireEvent.press(await screen.findByLabelText('Preview r.pdf'));
    expect(await screen.findByText('This device cannot open files.')).toBeTruthy();
    expect(screen.queryByTestId('thread-no-open')).toBeNull();
  });

  // Design #cd-offline-note: the note shows when the peer is Offline. Away is
  // still on the network, so it shows nothing.
  it('shows the offline note for an offline peer and not for an away peer', async () => {
    const off = { ...peer, presence: 'offline' as const, online: false };
    const first = mount(fakeEngine([off]));
    expect(
      await screen.findByText('Pixel 9 is not on this Wi-Fi. What you send waits here and goes when they are back.'),
    ).toBeTruthy();
    // The design draws the wifi-off icon in place of the tone dot.
    expect(screen.getByTestId('wifi-off-icon')).toBeTruthy();
    first.unmount();
    mount(fakeEngine([{ ...peer, presence: 'away' as const }]));
    expect(await screen.findByText('Pixel 9')).toBeTruthy();
    expect(screen.queryByText(/is not on this Wi-Fi/)).toBeNull();
    expect(screen.queryByTestId('wifi-off-icon')).toBeNull();
  });

  // A plain Note keeps the tone dot, so it carries no wifi-off icon.
  it('draws no wifi-off icon on a plain Note', () => {
    render(<Note body="just a note" />);
    expect(screen.queryByTestId('wifi-off-icon')).toBeNull();
  });

  // Design #cd-offline-note: only an explicit offline presence gets the note.
  // A device the engine did not mark offline is not known to be offline.
  it('shows no offline note for a device with no presence field', async () => {
    const bare: DeviceInfo = { deviceId: peer.deviceId, name: 'Pixel 9', addr: '', paired: true };
    const first = mount(fakeEngine([bare]));
    expect(await screen.findByText('Pixel 9')).toBeTruthy();
    expect(screen.queryByText(/is not on this Wi-Fi/)).toBeNull();
    first.unmount();
    mount(fakeEngine([{ ...peer, presence: 'offline' as const, online: false }]));
    expect(
      await screen.findByText('Pixel 9 is not on this Wi-Fi. What you send waits here and goes when they are back.'),
    ).toBeTruthy();
  });

  // Review Focus 4.
  it('shows Not paired any more for a device the engine does not list', async () => {
    const engine = fakeEngine([]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([threadItem({ text: 'old history' })]));
    const { onBack } = mount(engine);
    expect(await screen.findByText('Not paired any more')).toBeTruthy();
    expect(screen.queryByText('old history')).toBeNull();
    expect(screen.queryByPlaceholderText('Or type a note')).toBeNull();
    fireEvent.press(screen.getByTestId('thread-back'));
    expect(onBack).toHaveBeenCalled();
  });

  it('switches to Not paired any more when the device leaves while the thread is open', async () => {
    const engine = fakeEngine([peer]);
    const devices = jest.spyOn(engine, 'devices');
    mount(engine);
    await screen.findByText('Nothing here yet');
    devices.mockResolvedValue([]);
    emit(engine, { type: 'pairing.revoked', deviceId: peer.deviceId });
    expect(await screen.findByText('Not paired any more')).toBeTruthy();
  });

  // HEAD 824b3d7: a pairing that the user has not confirmed is pending and has
  // paired false. A deep link to such a peer must not open a composer.
  it('treats a device that is listed but not paired as Not paired any more', async () => {
    mount(fakeEngine([{ ...peer, paired: false }]));
    expect(await screen.findByText('Not paired any more')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Or type a note')).toBeNull();
  });

  it('goes back from the header button', async () => {
    const { onBack } = mount(fakeEngine([peer]));
    fireEvent.press(await screen.findByTestId('thread-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('names the bubble actions and sizes the header controls for touch', async () => {
    mount(fakeEngine([peer]));
    const back = await screen.findByTestId('thread-back');
    expect(back.props.accessibilityRole).toBe('button');
    expect(back.props.accessibilityHint ?? back.props.accessibilityLabel).toBeTruthy();
  });
});


describe('ThreadScreen folders', () => {
  afterEach(async () => { await settle(0); });

  const FOLDER = 'ee'.repeat(16);
  const kid = (rel: string, p: Partial<Parameters<typeof threadItem>[0]> = {}) =>
    threadItem({
      transferId: FOLDER,
      itemIndex: rel.length,
      type: 'file',
      text: null,
      name: rel.split('/').pop() ?? rel,
      size: 1000,
      destPath: `/d/album/${rel}`,
      group: { name: 'album', rel, files: 2, bytes: 2000 },
      ...p,
    });

  it('renders the items of one folder as one folder bubble and no file bubble', async () => {
    const engine = fakeEngine([peer]);
    const a = kid('a.jpg', { itemIndex: 0 });
    const b = kid('sub/b.pdf', { itemIndex: 1 });
    const loose = threadItem({ transferId: 'cc'.repeat(16), type: 'file', text: null, name: 'loose.pdf', size: 10, destPath: '/d/loose.pdf' });
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([a, b, loose]));
    mount(engine);
    expect(await screen.findByTestId(`bubble-folder-${FOLDER}:album`)).toBeTruthy();
    expect(screen.queryByTestId(`bubble-${FOLDER}:0`)).toBeNull();
    expect(screen.queryByTestId(`bubble-${FOLDER}:1`)).toBeNull();
    // A loose file keeps its own bubble.
    expect(screen.getByTestId(`bubble-${'cc'.repeat(16)}:0`)).toBeTruthy();
  });

  it('opens the folder sheet and shows where the files went', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([
      kid('a.jpg', { itemIndex: 0, destPath: 'photos:1' }),
      kid('b.pdf', { itemIndex: 1 }),
    ]));
    mount(engine, { library: 'Photos', saveFolder: 'Daak', isMedia: (p: string) => p.endsWith('.jpg') });
    expect(await screen.findByText('Saved to Photos and Daak')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Open album'));
    expect(screen.getByText('Photos and videos are in Photos. Other files are in Daak / album.')).toBeTruthy();
  });

  it('says the library save failed when media stayed in the save folder', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([kid('a.jpg', { itemIndex: 0 }), kid('b.pdf', { itemIndex: 1 })]));
    mount(engine, { library: 'Gallery', saveFolder: 'Downloads', isMedia: (p: string) => p.endsWith('.jpg') });
    fireEvent.press(await screen.findByLabelText('Open album'));
    expect(screen.getByText("Couldn't save to Gallery. All files are in Downloads / album.")).toBeTruthy();
  });

  it('has no library place when the host has no library', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([kid('a.jpg', { itemIndex: 0 }), kid('b.pdf', { itemIndex: 1 })]));
    mount(engine, { saveFolder: 'Downloads / Daak', isMedia: (p: string) => p.endsWith('.jpg') });
    expect(await screen.findByText('Saved to Downloads / Daak')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Open album'));
    expect(screen.queryByTestId('folder-banner')).toBeNull();
  });

  it('retries one failed file of a sent folder with engine.retry', async () => {
    const engine = fakeEngine([peer]);
    const out = { direction: 'out' as const, transferState: 'done' };
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([
      kid('a.txt', { ...out, itemIndex: 0 }),
      kid('b.txt', { ...out, itemIndex: 1, state: 'failed' }),
    ]));
    const retry = jest.spyOn(engine, 'retry').mockResolvedValue();
    mount(engine);
    expect(await screen.findByText("Couldn't send 1 of 2")).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Open album'));
    fireEvent.press(screen.getByLabelText('Retry sending b.txt'));
    await waitFor(() => expect(retry).toHaveBeenCalledWith(FOLDER));
  });

  it('stops a waiting folder after the confirm sheet', async () => {
    const engine = fakeEngine([peer]);
    const waiting = { direction: 'out' as const, state: 'pending' as const, transferState: 'queued' };
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([
      kid('a.txt', { ...waiting, itemIndex: 0 }),
      kid('b.txt', { ...waiting, itemIndex: 1 }),
    ]));
    const cancel = jest.spyOn(engine, 'cancel').mockResolvedValue();
    mount(engine);
    fireEvent.press(await screen.findByLabelText('Open album'));
    fireEvent.press(screen.getByTestId('folder-stop'));
    expect(screen.getByText('Stop sending?')).toBeTruthy();
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('confirm-stop'));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(FOLDER));
  });
});

// Task 9, frames F3 and F4: stage a folder in the composer.
describe('ThreadScreen folder staging', () => {
  afterEach(async () => { await settle(0); });

  const COPY = '/data/cache/daak-send/U1/album';
  const STATS = { files: 12, bytes: 34 * 1024 * 1024 };
  const flat = (s: unknown) => StyleSheet.flatten(s as StyleProp<ViewStyle>) ?? {};

  // The phone host: a folder picker, the stats, and the discard of the copy.
  const phone = (over: Partial<React.ComponentProps<typeof ThreadScreen>> = {}) => ({
    onPickFiles: jest.fn(async () => ['/data/cache/a.pdf']),
    onPickFolder: jest.fn(async (): Promise<string | null> => COPY),
    folderStats: jest.fn(async (p: string) => (p === COPY ? STATS : null)),
    discardPickedCopy: jest.fn(async () => {}),
    ...over,
  });

  const stageFolder = async () => {
    fireEvent.press(screen.getByTestId('pick-files'));
    fireEvent.press(screen.getByTestId('pick-menu-folder'));
    return screen.findByText('album · 12 files');
  };

  it('opens the file picker at once when the host gives no folder picker', async () => {
    const onPickFiles = jest.fn(async () => ['/Users/d/a.pdf']);
    mount(fakeEngine([peer]), { onPickFiles });
    await screen.findByText('Nothing here yet');
    fireEvent.press(screen.getByTestId('pick-files'));
    expect(onPickFiles).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('pick-menu-folder')).toBeNull();
    expect(await screen.findByText('a.pdf')).toBeTruthy();
  });

  it('shows the label that the macOS host gives', async () => {
    mount(fakeEngine([peer]), { onPickFiles: async () => [], pickLabel: 'Add files or folders' });
    expect(await screen.findByText('Add files or folders')).toBeTruthy();
    expect(screen.queryByTestId('paperclip-icon')).toBeNull();
  });

  it('shows a paperclip and opens a menu with Files and Folder on a phone', async () => {
    const host = phone();
    mount(fakeEngine([peer]), host);
    await screen.findByText('Nothing here yet');
    const add = screen.getByTestId('pick-files');
    expect(add.props.accessibilityLabel).toBe('Add files or folders');
    expect(screen.getByTestId('paperclip-icon')).toBeTruthy();
    expect(screen.queryByText('Add files')).toBeNull();
    fireEvent.press(add);
    expect(host.onPickFiles).not.toHaveBeenCalled();
    expect(screen.getByText('Files')).toBeTruthy();
    expect(screen.getByText('Folder')).toBeTruthy();
    fireEvent.press(screen.getByTestId('pick-menu-files'));
    expect(host.onPickFiles).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('pick-menu-folder')).toBeNull();
    expect(await screen.findByText('a.pdf')).toBeTruthy();
  });

  it('keeps the note field at its place and full width in both add button forms', async () => {
    for (const props of [phone(), { onPickFiles: async () => [], pickLabel: 'Add files or folders' }]) {
      const { unmount } = mount(fakeEngine([peer]), props);
      await screen.findByText('Nothing here yet');
      const note = screen.getByPlaceholderText('Or type a note');
      expect(flat(note.props.style).flex).toBe(1);
      // The order in the row: the add button, the note field, then Send.
      const row = screen.getByTestId('composer-row');
      const ids = React.Children.toArray(row.props.children).map(
        (c) => (c as React.ReactElement<{ testID?: string; placeholder?: string }>).props.testID
          ?? (c as React.ReactElement<{ placeholder?: string }>).props.placeholder,
      );
      expect(ids).toEqual(['pick-files', 'Or type a note', 'send']);
      unmount();
    }
    // The paperclip is a 44 point square, so it does not take the width of the note field.
    mount(fakeEngine([peer]), phone());
    await screen.findByText('Nothing here yet');
    expect(flat(screen.getByTestId('pick-files').props.style).width).toBe(44);
  });

  it('stages a picked folder as one chip with its file count', async () => {
    const host = phone();
    const engine = fakeEngine([peer]);
    const send = jest.spyOn(engine, 'send');
    mount(engine, host);
    await screen.findByText('Nothing here yet');
    expect(await stageFolder()).toBeTruthy();
    expect(host.onPickFolder).toHaveBeenCalledTimes(1);
    expect(host.folderStats).toHaveBeenCalledWith(COPY);
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByTestId('send')).not.toBeDisabled();
  });

  it('removes the folder chip with its x and discards the copy', async () => {
    const host = phone();
    mount(fakeEngine([peer]), host);
    await screen.findByText('Nothing here yet');
    await stageFolder();
    expect(screen.getByLabelText('Remove album')).toBeTruthy();
    fireEvent.press(screen.getByTestId('remove-album'));
    expect(screen.queryByText('album · 12 files')).toBeNull();
    await waitFor(() => expect(host.discardPickedCopy).toHaveBeenCalledWith(COPY));
  });

  it('lists a folder as one row in the review sheet', async () => {
    const host = phone();
    const fileSizes = jest.fn(async (p: string[]) => p.map(() => 1024));
    mount(fakeEngine([peer]), { ...host, initialFiles: ['/d/f0.pdf', '/d/f1.pdf', '/d/f2.pdf'], actions: { fileSizes } });
    await screen.findByText('f0.pdf');
    fireEvent.press(screen.getByTestId('pick-files'));
    fireEvent.press(screen.getByTestId('pick-menu-folder'));
    fireEvent.press(await screen.findByText('4 items · Review'));
    expect(screen.getByText('album')).toBeTruthy();
    expect(screen.getByText('12 files · 34.0 MB')).toBeTruthy();
    // The folder size counts in the total. The folder is never asked for a file size.
    expect(await screen.findByText('4 items · 34.0 MB')).toBeTruthy();
    expect(fileSizes).not.toHaveBeenCalledWith(expect.arrayContaining([COPY]));
    fireEvent.press(screen.getByTestId('review-remove-album'));
    await waitFor(() => expect(host.discardPickedCopy).toHaveBeenCalledWith(COPY));
    expect(screen.queryByText('album')).toBeNull();
  });

  // The pick rejects before the facade knows a folder name, so the text says "this folder".
  it.each([
    ['NO_SPACE:2254857830', 'Not enough space to prepare this folder. Free 2.1 GB and try again.'],
    ['EMPTY', 'This folder has no files to send.'],
    ['E_COPY', "Couldn't prepare this folder. Check that every file in it is on this device and try again."],
    ['some other native error', "Couldn't prepare this folder. Check that every file in it is on this device and try again."],
    ['NOT_DOWNLOADED', 'This folder has files that are not downloaded yet. Open the Files app, download the folder, and try again.'],
  ])('shows the warning for a %s pick and stages no chip', async (message, text) => {
    const host = phone({ onPickFolder: jest.fn(async () => { throw new Error(message); }) });
    mount(fakeEngine([peer]), host);
    await screen.findByText('Nothing here yet');
    fireEvent.press(screen.getByTestId('pick-files'));
    fireEvent.press(screen.getByTestId('pick-menu-folder'));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByTestId('remove-album')).toBeNull();
    expect(screen.queryByText('Preparing…')).toBeNull();
    // The next pick clears the warning.
    fireEvent.press(screen.getByTestId('pick-files'));
    fireEvent.press(screen.getByTestId('pick-menu-files'));
    await screen.findByText('a.pdf');
    expect(screen.queryByText(text)).toBeNull();
  });

  it('shows Preparing… and disables Send while the folder copies', async () => {
    let finish: (p: string | null) => void = () => {};
    const host = phone({ onPickFolder: jest.fn(() => new Promise<string | null>((r) => { finish = r; })) });
    mount(fakeEngine([peer]), host);
    await screen.findByText('Nothing here yet');
    fireEvent.changeText(screen.getByPlaceholderText('Or type a note'), 'hi');
    fireEvent.press(screen.getByTestId('pick-files'));
    fireEvent.press(screen.getByTestId('pick-menu-folder'));
    expect(await screen.findByText('Preparing…')).toBeTruthy();
    expect(screen.getByTestId('send')).toBeDisabled();
    await act(async () => { finish(COPY); });
    expect(await screen.findByText('album · 12 files')).toBeTruthy();
    expect(screen.queryByText('Preparing…')).toBeNull();
    expect(screen.getByTestId('send')).not.toBeDisabled();
  });

  it('drops the chip on a cancelled picker', async () => {
    const host = phone({ onPickFolder: jest.fn(async () => null) });
    mount(fakeEngine([peer]), host);
    await screen.findByText('Nothing here yet');
    fireEvent.press(screen.getByTestId('pick-files'));
    fireEvent.press(screen.getByTestId('pick-menu-folder'));
    await waitFor(() => expect(host.onPickFolder).toHaveBeenCalled());
    await settle();
    expect(screen.queryByText('Preparing…')).toBeNull();
    expect(screen.getByTestId('send')).toBeDisabled();
  });

  it('treats a null stat for a copied folder as a copy error and discards the copy', async () => {
    const host = phone({ folderStats: jest.fn(async () => null) });
    mount(fakeEngine([peer]), host);
    await screen.findByText('Nothing here yet');
    fireEvent.press(screen.getByTestId('pick-files'));
    fireEvent.press(screen.getByTestId('pick-menu-folder'));
    expect(
      await screen.findByText("Couldn't prepare this folder. Check that every file in it is on this device and try again."),
    ).toBeTruthy();
    await waitFor(() => expect(host.discardPickedCopy).toHaveBeenCalledWith(COPY));
    expect(screen.queryByTestId('remove-album')).toBeNull();
    expect(screen.queryByText('Preparing…')).toBeNull();
    expect(screen.getByTestId('send')).toBeDisabled();
  });

  it('does not measure the files that a phone picks', async () => {
    const host = phone({ onPickFiles: jest.fn(async () => ['/c/a.pdf', '/c/b.pdf', '/c/c.pdf']) });
    mount(fakeEngine([peer]), host);
    await screen.findByText('Nothing here yet');
    fireEvent.press(screen.getByTestId('pick-files'));
    fireEvent.press(screen.getByTestId('pick-menu-files'));
    await screen.findByText('3 files ready');
    await settle();
    expect(host.folderStats).not.toHaveBeenCalled();
  });

  it('measures each path once when the host has no folder picker', async () => {
    const folderStats = jest.fn(async () => null);
    mount(fakeEngine([peer]), { onPickFiles: async () => ['/u/a.pdf', '/u/b'], folderStats });
    await screen.findByText('Nothing here yet');
    fireEvent.press(screen.getByTestId('pick-files'));
    await waitFor(() => expect(folderStats).toHaveBeenCalledTimes(2));
  });

  it('disables the add button while a send is in flight', async () => {
    let done: (v: { transferId: string; queued: boolean }) => void = () => {};
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'send').mockImplementation(() => new Promise((r) => { done = r; }));
    mount(engine, phone());
    await screen.findByText('Nothing here yet');
    await stageFolder();
    fireEvent.press(screen.getByTestId('send'));
    await waitFor(() => expect(screen.getByTestId('pick-files')).toBeDisabled());
    await act(async () => { done({ transferId: TID, queued: true }); });
    await waitFor(() => expect(screen.getByTestId('pick-files')).not.toBeDisabled());
  });

  it('discards a copy that arrives after the screen unmounts', async () => {
    let finish: (p: string | null) => void = () => {};
    const host = phone({ onPickFolder: jest.fn(() => new Promise<string | null>((r) => { finish = r; })) });
    const { unmount } = mount(fakeEngine([peer]), host);
    await screen.findByText('Nothing here yet');
    fireEvent.press(screen.getByTestId('pick-files'));
    fireEvent.press(screen.getByTestId('pick-menu-folder'));
    await screen.findByText('Preparing…');
    unmount();
    await act(async () => { finish(COPY); });
    await waitFor(() => expect(host.discardPickedCopy).toHaveBeenCalledWith(COPY));
  });

  it('ignores a second Folder tap while a copy prepares', async () => {
    let finish: (p: string | null) => void = () => {};
    const host = phone({ onPickFolder: jest.fn(() => new Promise<string | null>((r) => { finish = r; })) });
    mount(fakeEngine([peer]), host);
    await screen.findByText('Nothing here yet');
    fireEvent.press(screen.getByTestId('pick-files'));
    fireEvent.press(screen.getByTestId('pick-menu-folder'));
    await screen.findByText('Preparing…');
    fireEvent.press(screen.getByTestId('pick-files'));
    fireEvent.press(screen.getByTestId('pick-menu-folder'));
    expect(host.onPickFolder).toHaveBeenCalledTimes(1);
    await act(async () => { finish(COPY); });
    expect(await screen.findByText('album · 12 files')).toBeTruthy();
  });

  it('discards a copy that arrives after Cancel', async () => {
    let finish: (p: string | null) => void = () => {};
    const host = phone({ onPickFolder: jest.fn(() => new Promise<string | null>((r) => { finish = r; })) });
    mount(fakeEngine([peer]), host);
    await screen.findByText('Nothing here yet');
    fireEvent.press(screen.getByTestId('pick-files'));
    fireEvent.press(screen.getByTestId('pick-menu-folder'));
    fireEvent.press(await screen.findByTestId('prepare-cancel'));
    expect(screen.queryByText('Preparing…')).toBeNull();
    await act(async () => { finish(COPY); });
    await waitFor(() => expect(host.discardPickedCopy).toHaveBeenCalledWith(COPY));
    expect(screen.queryByText('album · 12 files')).toBeNull();
  });

  it('discards each copied folder after engine.send resolves', async () => {
    const host = phone();
    const engine = fakeEngine([peer]);
    const send = jest.spyOn(engine, 'send').mockResolvedValue({ transferId: TID, queued: true });
    mount(engine, host);
    await screen.findByText('Nothing here yet');
    await stageFolder();
    fireEvent.press(screen.getByTestId('pick-files'));
    fireEvent.press(screen.getByTestId('pick-menu-files'));
    await screen.findByText('a.pdf');
    expect(host.discardPickedCopy).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('send'));
    await waitFor(() => expect(host.discardPickedCopy).toHaveBeenCalledWith(COPY));
    expect(send).toHaveBeenCalledWith({ peerDeviceId: peer.deviceId, files: [COPY, '/data/cache/a.pdf'] });
    // A plain file is not a folder copy.
    expect(host.discardPickedCopy).toHaveBeenCalledTimes(1);
  });

  it('keeps the copy when the send fails', async () => {
    const host = phone();
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'send').mockRejectedValue(new Error('no'));
    mount(engine, host);
    await screen.findByText('Nothing here yet');
    await stageFolder();
    fireEvent.press(screen.getByTestId('send'));
    expect(await screen.findByTestId('thread-result')).toBeTruthy();
    expect(host.discardPickedCopy).not.toHaveBeenCalled();
    expect(screen.getByText('album · 12 files')).toBeTruthy();
  });

  it('discards the staged copies when the composer goes away', async () => {
    const host = phone();
    const { unmount } = mount(fakeEngine([peer]), host);
    await screen.findByText('Nothing here yet');
    await stageFolder();
    unmount();
    expect(host.discardPickedCopy).toHaveBeenCalledWith(COPY);
  });

  it('never throws when the discard fails', async () => {
    const host = phone({ discardPickedCopy: jest.fn(async () => { throw new Error('gone'); }) });
    mount(fakeEngine([peer]), host);
    await screen.findByText('Nothing here yet');
    await stageFolder();
    fireEvent.press(screen.getByTestId('remove-album'));
    await settle();
    expect(screen.getByTestId('pick-files')).toBeTruthy();
  });

  // Review Focus 1: the macOS folderStats gives 0 files for an empty folder. The engine
  // skips or refuses it, so the composer refuses it first, with its name.
  it('does not stage an empty folder beside a loose file and says why', async () => {
    mount(fakeEngine([peer]), {
      onPickFiles: async () => ['/Users/d/empty', '/Users/d/a.pdf'],
      folderStats: async (p: string) => (p === '/Users/d/empty' ? { files: 0, bytes: 0 } : null),
      pickLabel: 'Add files or folders',
    });
    await screen.findByText('Nothing here yet');
    fireEvent.press(screen.getByTestId('pick-files'));
    expect(await screen.findByText('"empty" has no files to send.')).toBeTruthy();
    expect(screen.queryByTestId('remove-empty')).toBeNull();
    expect(screen.getByText('a.pdf')).toBeTruthy();
  });

  it('stages nothing for an empty folder alone and keeps Send disabled', async () => {
    mount(fakeEngine([peer]), {
      onPickFiles: async () => ['/Users/d/empty'],
      folderStats: async () => ({ files: 0, bytes: 0 }),
      pickLabel: 'Add files or folders',
    });
    await screen.findByText('Nothing here yet');
    fireEvent.press(screen.getByTestId('pick-files'));
    expect(await screen.findByText('"empty" has no files to send.')).toBeTruthy();
    expect(screen.queryByTestId('remove-empty')).toBeNull();
    expect(screen.getByTestId('send')).toBeDisabled();
  });

  // The send reads the copy. Back during the send must not delete it.
  it('keeps the copy of a pending send at unmount and discards it after the send', async () => {
    const host = phone();
    const engine = fakeEngine([peer]);
    let finish: () => void = () => {};
    jest.spyOn(engine, 'send').mockImplementation(
      () => new Promise((r) => { finish = () => r({ transferId: TID, queued: true }); }),
    );
    const { unmount } = mount(engine, host);
    await screen.findByText('Nothing here yet');
    await stageFolder();
    fireEvent.press(screen.getByTestId('send'));
    await waitFor(() => expect(engine.send).toHaveBeenCalled());
    unmount();
    expect(host.discardPickedCopy).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    await waitFor(() => expect(host.discardPickedCopy).toHaveBeenCalledWith(COPY));
    expect(host.discardPickedCopy).toHaveBeenCalledTimes(1);
  });

  it('discards the copy of a send that fails after unmount', async () => {
    const host = phone();
    const engine = fakeEngine([peer]);
    let fail: () => void = () => {};
    jest.spyOn(engine, 'send').mockImplementation(
      () => new Promise((_r, j) => { fail = () => j(new Error('no')); }),
    );
    const { unmount } = mount(engine, host);
    await screen.findByText('Nothing here yet');
    await stageFolder();
    fireEvent.press(screen.getByTestId('send'));
    await waitFor(() => expect(engine.send).toHaveBeenCalled());
    unmount();
    expect(host.discardPickedCopy).not.toHaveBeenCalled();
    await act(async () => { fail(); });
    await waitFor(() => expect(host.discardPickedCopy).toHaveBeenCalledWith(COPY));
  });

  // macOS: the one panel picks files and folders. A folder there is the user's
  // own folder, not a copy, so the composer never discards it.
  it('shows a folder from the macOS panel as a folder chip and never discards it', async () => {
    const discardPickedCopy = jest.fn(async () => {});
    mount(fakeEngine([peer]), {
      onPickFiles: async () => ['/Users/d/album'],
      folderStats: async (p: string) => (p === '/Users/d/album' ? STATS : null),
      discardPickedCopy,
      pickLabel: 'Add files or folders',
    });
    await screen.findByText('Nothing here yet');
    fireEvent.press(screen.getByTestId('pick-files'));
    expect(await screen.findByText('album · 12 files')).toBeTruthy();
    fireEvent.press(screen.getByTestId('remove-album'));
    await settle();
    expect(discardPickedCopy).not.toHaveBeenCalled();
  });
});

// Task 11 (A1, A9): the bubbles of a running transfer are progress bars.
describe('ThreadScreen progress in the bubbles', () => {
  afterEach(async () => { await settle(0); });

  const MIB = 1024 * 1024;
  // Three files of 10 MiB each, in one running transfer.
  const files3 = (p: Partial<Parameters<typeof threadItem>[0]> = {}) =>
    [0, 1, 2].map((i) => threadItem({
      transferId: TID, itemIndex: i, type: 'file', text: null, name: `f${i}.bin`, size: 10 * MIB,
      direction: 'out', state: 'pending', transferState: 'active', ...p,
    }));
  const fillOf = (i: number) => screen.queryByTestId(`bubble-fill-${TID}:${i}`);
  const nowOf = (i: number) => fillOf(i)?.props.accessibilityValue?.now;
  const progress = (engine: DaakEngine, bytesDone: number, bytesTotal = 30 * MIB) =>
    emit(engine, { type: 'transfer.progress', transferId: TID, bytesDone, bytesTotal });

  it('a running send fills its bubbles from transfer.progress', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage(files3()));
    mount(engine);
    await screen.findByText('f0.bin');
    progress(engine, 15 * MIB);
    await waitFor(() => expect(nowOf(0)).toBe(100));
    expect(nowOf(1)).toBe(50);
    expect(nowOf(2)).toBe(0);
    // Bytes above the sum and a total of 0 give no NaN and no fill above 100.
    progress(engine, 99 * MIB, 0);
    await waitFor(() => expect(nowOf(2)).toBe(100));
    expect(nowOf(0)).toBe(100);
  });

  it('a running receive does the same', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage(files3({ direction: 'in', state: 'receiving' })));
    mount(engine);
    await screen.findByText('f0.bin');
    progress(engine, 25 * MIB);
    await waitFor(() => expect(nowOf(2)).toBe(50));
    expect(nowOf(0)).toBe(100);
    expect(nowOf(1)).toBe(100);
    // A receiver cannot stop the send of the peer.
    expect(screen.queryByTestId('thread-stop-' + TID)).toBeNull();
  });

  it('uses the summary bytes before the first progress event', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage(files3()));
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([summary({ bytesDone: 5 * MIB, bytesTotal: 30 * MIB })]);
    mount(engine);
    await waitFor(() => expect(nowOf(0)).toBe(50));
  });

  it('during the warm-up the meta line shows the percent only', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage(files3()));
    mount(engine);
    await screen.findByText('f0.bin');
    progress(engine, 15 * MIB);
    expect(await screen.findByText('50%')).toBeTruthy();
    expect(screen.getByText('100%')).toBeTruthy();
    expect(screen.queryByText(/MiB\/s/)).toBeNull();
  });

  // The hook reads Date.now. The test moves the clock by hand.
  const warm = async (engine: DaakEngine, clock: { now: number }) => {
    for (let i = 1; i <= 5; i++) {
      clock.now += 500;
      progress(engine, i * 3 * MIB);
    }
  };

  it('the meta line shows the percent and the speed after the warm-up', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage(files3()));
    const clock = { now: 1_000_000 };
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => clock.now);
    try {
      mount(engine);
      await screen.findByText('f0.bin');
      await warm(engine, clock);
      // 15 MiB done: f0 is full, f1 fills at 50%.
      expect(await screen.findByText(/^50% · \d+\.\d MiB\/s/)).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it('speed shows only on the bubble that is filling', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage(files3()));
    const clock = { now: 1_000_000 };
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => clock.now);
    try {
      mount(engine);
      await screen.findByText('f0.bin');
      await warm(engine, clock);
      await screen.findByText(/MiB\/s/);
      expect(screen.getAllByText(/MiB\/s/)).toHaveLength(1);
      expect(screen.getByText('100%')).toBeTruthy();
      expect(screen.getByText('0%')).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it('a 3-file transfer shows one Stop sending, on the first running bubble', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage(files3()));
    // The old card is still on the screen. It must not add a second Stop.
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([summary()]);
    const cancel = jest.spyOn(engine, 'cancel').mockResolvedValue();
    mount(engine);
    await screen.findByTestId('thread-active-' + TID);
    await screen.findByText('f0.bin');
    expect(screen.getAllByTestId('thread-stop-' + TID)).toHaveLength(1);
    expect(within(screen.getByTestId(`bubble-${TID}:0`)).getByTestId('thread-stop-' + TID)).toBeTruthy();
    fireEvent.press(screen.getByTestId('thread-stop-' + TID));
    fireEvent.press(screen.getByTestId('confirm-stop'));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(TID));
  });

  it('a 40-file transfer shows one Stop sending', async () => {
    const engine = fakeEngine([peer]);
    const items = Array.from({ length: 40 }, (_, i) => threadItem({
      transferId: TID, itemIndex: i, type: 'file', text: null, name: `g${i}.bin`, size: MIB,
      direction: 'out', state: 'pending', transferState: 'active',
    }));
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage(items));
    mount(engine);
    await screen.findByText('g39.bin');
    expect(screen.getAllByTestId('thread-stop-' + TID)).toHaveLength(1);
  });

  it('a running sent folder carries the one Stop and fills by files', async () => {
    const engine = fakeEngine([peer]);
    const items = files3({ group: null }).map((it, i) => ({
      ...it, group: { name: 'album', rel: `f${i}.bin`, files: 3, bytes: 30 * MIB },
    }));
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage(items));
    mount(engine);
    await screen.findByTestId(`bubble-folder-${TID}:album`);
    progress(engine, 20 * MIB);
    expect(await screen.findByText('2 of 3 files')).toBeTruthy();
    expect(screen.getAllByTestId('thread-stop-' + TID)).toHaveLength(1);
    expect(within(screen.getByTestId(`bubble-folder-${TID}:album`)).getByTestId('thread-stop-' + TID)).toBeTruthy();
  });

  it('a cut item list draws no fill', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage(files3({ truncated: true })));
    mount(engine);
    await screen.findByText('f0.bin');
    progress(engine, 15 * MIB);
    await settle();
    expect(fillOf(0)).toBeNull();
    expect(fillOf(1)).toBeNull();
    // Stop still shows, once.
    expect(screen.getAllByTestId('thread-stop-' + TID)).toHaveLength(1);
  });

  it('keeps the fill on a transfer that just finished, so the fill fades out', async () => {
    const engine = fakeEngine([peer]);
    const list = jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage(files3({ direction: 'in', state: 'receiving' })));
    mount(engine);
    await screen.findByText('f0.bin');
    progress(engine, 25 * MIB);
    await waitFor(() => expect(nowOf(2)).toBe(50));
    list.mockResolvedValue(threadPage(files3({ direction: 'in', state: 'done', transferState: 'done' })));
    emit(engine, { type: 'transfer.done', transferId: TID } as DaakEvent);
    await waitFor(() => expect(nowOf(2)).toBe(100));
    expect(screen.queryByText('100%')).toBeNull();
  });

  it('a cut item list draws no fill after the transfer ends', async () => {
    const engine = fakeEngine([peer]);
    const list = jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage(files3({ truncated: true })));
    mount(engine);
    await screen.findByText('f0.bin');
    progress(engine, 15 * MIB);
    list.mockResolvedValue(threadPage(files3({ truncated: true, state: 'done', transferState: 'done' })));
    emit(engine, { type: 'transfer.done', transferId: TID } as DaakEvent);
    await waitFor(() => expect(screen.queryByTestId('thread-stop-' + TID)).toBeNull());
    expect(fillOf(0)).toBeNull();
  });

  // Fix round 1: a folder shows the speed of its transfer.
  const inFolder = (items: ReturnType<typeof files3>, n = items.length) => items.map((it, i) => (i < n
    ? { ...it, group: { name: 'album', rel: `f${i}.bin`, files: n, bytes: n * 10 * MIB } }
    : it));
  const withClock = async (body: (clock: { now: number }) => Promise<void>) => {
    const clock = { now: 1_000_000 };
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => clock.now);
    try { await body(clock); } finally { spy.mockRestore(); }
  };

  it('a folder send shows the speed after the warm-up', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage(inFolder(files3())));
    await withClock(async (clock) => {
      mount(engine);
      await screen.findByTestId(`bubble-folder-${TID}:album`);
      await warm(engine, clock);
      expect(await screen.findByText(/^1 of 3 files · \d+\.\d MiB\/s/)).toBeTruthy();
    });
  });

  it('a folder receive shows the speed after the warm-up', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage(inFolder(files3({ direction: 'in', state: 'receiving' }))));
    await withClock(async (clock) => {
      mount(engine);
      await screen.findByTestId(`bubble-folder-${TID}:album`);
      await warm(engine, clock);
      expect(await screen.findByText(/^1 of 3 files · \d+\.\d MiB\/s/)).toBeTruthy();
    });
  });

  it('during the warm-up the folder shows the count only', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage(inFolder(files3())));
    mount(engine);
    await screen.findByTestId(`bubble-folder-${TID}:album`);
    progress(engine, 15 * MIB);
    expect(await screen.findByText('1 of 3 files')).toBeTruthy();
    expect(screen.queryByText(/MiB\/s/)).toBeNull();
  });

  it('a mixed transfer shows the speed on the folder while the folder fills', async () => {
    const engine = fakeEngine([peer]);
    // Items 0 and 1 are in the folder. Item 2 is a loose file.
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage(inFolder(files3(), 2)));
    await withClock(async (clock) => {
      mount(engine);
      await screen.findByText('f2.bin');
      await warm(engine, clock);
      expect(await screen.findByText(/^1 of 2 files · \d+\.\d MiB\/s/)).toBeTruthy();
      expect(screen.getAllByText(/MiB\/s/)).toHaveLength(1);
      expect(screen.getByText('0%')).toBeTruthy();
    });
  });

  it('a mixed transfer shows the speed on the loose file when the folder is full', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage(inFolder(files3(), 2)));
    await withClock(async (clock) => {
      mount(engine);
      await screen.findByText('f2.bin');
      // 5 steps of 5 MiB: 25 MiB done. The folder is full, f2 fills at 50%.
      for (let i = 1; i <= 5; i++) {
        clock.now += 500;
        progress(engine, i * 5 * MIB);
      }
      expect(await screen.findByText(/^50% · \d+\.\d MiB\/s/)).toBeTruthy();
      expect(screen.getAllByText(/MiB\/s/)).toHaveLength(1);
      expect(screen.getByText('2 of 2 files')).toBeTruthy();
    });
  });

  // Fix round 1: one percent pass for each transfer, not one for each row.
  it('computes the percents once for each transfer on each render', async () => {
    const engine = fakeEngine([peer]);
    const items = Array.from({ length: 50 }, (_, i) => threadItem({
      transferId: TID, itemIndex: i, type: 'file', text: null, name: `h${i}.bin`, size: MIB,
      direction: 'out', state: 'pending', transferState: 'active',
    }));
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage(items));
    const spy = jest.spyOn(progressModule, 'itemPercents');
    try {
      mount(engine);
      await screen.findByText('h49.bin');
      progress(engine, 10 * MIB, 50 * MIB);
      await waitFor(() => expect(nowOf(9)).toBe(100));
      spy.mockClear();
      progress(engine, 20 * MIB, 50 * MIB);
      await waitFor(() => expect(nowOf(19)).toBe(100));
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('two sends at once show 2 Stops and keep their progress apart', async () => {
    const engine = fakeEngine([peer]);
    const T2 = 'ee'.repeat(16);
    const two = [0, 1].map((i) => threadItem({
      transferId: T2, itemIndex: i, type: 'file', text: null, name: `t${i}.bin`, size: 10 * MIB,
      direction: 'out', state: 'pending', transferState: 'active', at: 1_700_000_100,
    }));
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([...files3(), ...two]));
    const cancel = jest.spyOn(engine, 'cancel').mockResolvedValue();
    mount(engine);
    await screen.findByText('t1.bin');
    progress(engine, 15 * MIB);
    await waitFor(() => expect(nowOf(1)).toBe(50));
    expect(screen.getByTestId(`bubble-fill-${T2}:0`).props.accessibilityValue.now).toBe(0);
    expect(screen.getByTestId(`bubble-fill-${T2}:1`).props.accessibilityValue.now).toBe(0);
    expect(within(screen.getByTestId(`bubble-${TID}:0`)).getByTestId('thread-stop-' + TID)).toBeTruthy();
    expect(within(screen.getByTestId(`bubble-${T2}:0`)).getByTestId('thread-stop-' + T2)).toBeTruthy();
    expect(screen.getAllByLabelText('Stop sending')).toHaveLength(2);
    fireEvent.press(screen.getByTestId('thread-stop-' + T2));
    fireEvent.press(screen.getByTestId('confirm-stop'));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(T2));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('a done transfer from an earlier session draws no fill', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage(files3({ state: 'done', transferState: 'done' })));
    mount(engine);
    await screen.findByText('f0.bin');
    expect(fillOf(0)).toBeNull();
  });
});

// Task 8: Add photos and the simple path.
describe('ThreadScreen add photos', () => {
  afterEach(async () => { await settle(0); });

  const refs = (...names: string[]) => names.map((n) => ({ token: `t-${n}`, name: n, size: 10 }));
  const host = () => {
    const media = {
      pick: jest.fn<Promise<MediaRef[]>, []>(async () => refs('a.jpg', 'b.mov')),
      materialize: jest.fn<Promise<string>, [string]>(async (t) => `/cache/daak-send/${t}`),
      fits: jest.fn<Promise<boolean>, [MediaRef[]]>(async () => true),
    };
    return {
      media,
      onPickFiles: jest.fn(async () => [] as string[]),
      onPickFolder: jest.fn(async (): Promise<string | null> => null),
      discardPickedCopy: jest.fn(async () => {}),
    };
  };
  const stage = async () => {
    fireEvent.press(screen.getByTestId('pick-files'));
    fireEvent.press(screen.getByTestId('pick-menu-photos'));
    return screen.findByText('a.jpg');
  };

  it('the sheet shows Add photos only when media is set', async () => {
    mount(fakeEngine([peer]), host());
    await screen.findByText('Nothing here yet');
    fireEvent.press(screen.getByTestId('pick-files'));
    expect(screen.getByTestId('pick-menu-photos')).toBeTruthy();
    expect(screen.getByText('Add photos')).toBeTruthy();
  });

  it('no media prop shows no Add photos button', async () => {
    const { media: _unused, ...rest } = host();
    mount(fakeEngine([peer]), rest);
    await screen.findByText('Nothing here yet');
    fireEvent.press(screen.getByTestId('pick-files'));
    expect(screen.queryByTestId('pick-menu-photos')).toBeNull();
  });

  it('picking refs shows them in the composer and a second pick appends and drops a repeated token', async () => {
    const h = host();
    mount(fakeEngine([peer]), h);
    await screen.findByText('Nothing here yet');
    await stage();
    expect(screen.getByText('b.mov')).toBeTruthy();
    h.media.pick.mockResolvedValueOnce([...refs('b.mov'), ...refs('c.png')]);
    fireEvent.press(screen.getByTestId('pick-files'));
    fireEvent.press(screen.getByTestId('pick-menu-photos'));
    expect(await screen.findByText('c.png')).toBeTruthy();
    expect(screen.getAllByText('b.mov')).toHaveLength(1);
    expect(screen.getByTestId('send')).not.toBeDisabled();
    fireEvent.press(screen.getByTestId('remove-media-t-a.jpg'));
    expect(screen.queryByText('a.jpg')).toBeNull();
  });

  it('a selection that fits is materialized one at a time and sent with one engine.send call', async () => {
    const h = host();
    const order: string[] = [];
    let open = 0;
    let most = 0;
    h.media.materialize.mockImplementation(async (t: string) => {
      open += 1; most = Math.max(most, open);
      await new Promise((r) => setTimeout(r, 5));
      order.push(t);
      open -= 1;
      return `/cache/daak-send/${t}`;
    });
    const engine = fakeEngine([peer]);
    const send = jest.spyOn(engine, 'send');
    mount(engine, { ...h, initialFiles: ['/Users/d/x.pdf'] });
    await screen.findByText('Nothing here yet');
    await stage();
    fireEvent.press(screen.getByTestId('send'));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith({
      peerDeviceId: peer.deviceId,
      files: ['/Users/d/x.pdf', '/cache/daak-send/t-a.jpg', '/cache/daak-send/t-b.mov'],
    });
    expect(order).toEqual(['t-a.jpg', 't-b.mov']);
    expect(most).toBe(1);
  });

  it('the copies are discarded only after engine.send resolves', async () => {
    const h = host();
    const engine = fakeEngine([peer]);
    let finish: (v: { transferId: string; queued: boolean }) => void = () => {};
    jest.spyOn(engine, 'send').mockImplementation(() => new Promise((r) => { finish = r; }));
    mount(engine, h);
    await screen.findByText('Nothing here yet');
    await stage();
    fireEvent.press(screen.getByTestId('send'));
    await waitFor(() => expect(engine.send).toHaveBeenCalledTimes(1));
    await settle();
    expect(h.discardPickedCopy).not.toHaveBeenCalled();
    await act(async () => { finish({ transferId: TID, queued: false }); });
    await waitFor(() => expect(h.discardPickedCopy).toHaveBeenCalledTimes(2));
    expect(h.discardPickedCopy).toHaveBeenCalledWith('/cache/daak-send/t-a.jpg');
    expect(screen.queryByText('a.jpg')).toBeNull();
  });

  it('a selection that does not fit shows the large-selection text and sends nothing', async () => {
    const h = host();
    h.media.fits.mockResolvedValue(false);
    const engine = fakeEngine([peer]);
    const send = jest.spyOn(engine, 'send');
    mount(engine, h);
    await screen.findByText('Nothing here yet');
    await stage();
    fireEvent.press(screen.getByTestId('send'));
    expect(await screen.findByText('Large selection is not supported yet')).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    expect(h.media.materialize).not.toHaveBeenCalled();
    expect(screen.getByText('a.jpg')).toBeTruthy();
  });

  it('NO_SPACE:<n> shows the photo no-space text and discards the copies already made', async () => {
    const h = host();
    h.media.materialize
      .mockResolvedValueOnce('/cache/daak-send/t-a.jpg')
      .mockRejectedValueOnce(new Error('NO_SPACE:2254857830'));
    const engine = fakeEngine([peer]);
    const send = jest.spyOn(engine, 'send');
    mount(engine, h);
    await screen.findByText('Nothing here yet');
    await stage();
    fireEvent.press(screen.getByTestId('send'));
    expect(await screen.findByText('Not enough space to prepare these photos. Free 2.1 GB and try again.')).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    expect(h.discardPickedCopy).toHaveBeenCalledWith('/cache/daak-send/t-a.jpg');
    expect(screen.getByText('b.mov')).toBeTruthy();
  });

  it('E_SOURCE_GONE shows its text', async () => {
    const h = host();
    h.media.materialize.mockRejectedValueOnce(new Error('E_SOURCE_GONE'));
    mount(fakeEngine([peer]), h);
    await screen.findByText('Nothing here yet');
    await stage();
    fireEvent.press(screen.getByTestId('send'));
    expect(await screen.findByText('Some items can no longer be read. Pick them again.')).toBeTruthy();
  });

  it('NOT_DOWNLOADED shows the photo wording', async () => {
    const h = host();
    h.media.materialize.mockRejectedValueOnce(new Error('NOT_DOWNLOADED'));
    mount(fakeEngine([peer]), h);
    await screen.findByText('Nothing here yet');
    await stage();
    fireEvent.press(screen.getByTestId('send'));
    expect(await screen.findByText('Some photos are not downloaded yet. Open the Photos app, download them, and try again.')).toBeTruthy();
  });

  it('a rejected engine.send discards the media copies made for that attempt', async () => {
    const h = host();
    const engine = fakeEngine([peer]);
    const send = jest.spyOn(engine, 'send').mockRejectedValueOnce(new Error('refused'));
    mount(engine, h);
    await screen.findByText('Nothing here yet');
    await stage();
    fireEvent.press(screen.getByTestId('send'));
    await screen.findByText('That send did not go through');
    expect(h.discardPickedCopy).toHaveBeenCalledWith('/cache/daak-send/t-a.jpg');
    expect(h.discardPickedCopy).toHaveBeenCalledWith('/cache/daak-send/t-b.mov');
    expect(h.discardPickedCopy).toHaveBeenCalledTimes(2);
    send.mockResolvedValue({ transferId: TID, queued: false });
    fireEvent.press(screen.getByTestId('send'));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(h.media.materialize).toHaveBeenCalledTimes(4);
  });

  it('unmounting while a photo is copied sends nothing and leaves no copy', async () => {
    const h = host();
    const gates: Array<(p: string) => void> = [];
    h.media.materialize.mockImplementation(() => new Promise<string>((r) => { gates.push(r); }));
    const engine = fakeEngine([peer]);
    const send = jest.spyOn(engine, 'send');
    const { unmount } = mount(engine, h);
    await screen.findByText('Nothing here yet');
    await stage();
    fireEvent.press(screen.getByTestId('send'));
    await waitFor(() => expect(gates).toHaveLength(1));
    unmount();
    await act(async () => { gates[0]('/cache/daak-send/t-a.jpg'); });
    await settle();
    expect(send).not.toHaveBeenCalled();
    expect(gates).toHaveLength(1);
    expect(h.discardPickedCopy).toHaveBeenCalledWith('/cache/daak-send/t-a.jpg');
  });

  // The final review (I3): Android keeps a read grant for each picked item.
  // The grant must go back when the composer no longer needs the ref.
  it('release is called with the sent tokens after a simple send resolves, not before', async () => {
    const h = host();
    const release = jest.fn<Promise<void>, [string[]]>(async () => {});
    const engine = fakeEngine([peer]);
    let finish: (v: { transferId: string; queued: boolean }) => void = () => {};
    jest.spyOn(engine, 'send').mockImplementation(() => new Promise((r) => { finish = r; }));
    mount(engine, { ...h, media: { ...h.media, release } });
    await screen.findByText('Nothing here yet');
    await stage();
    fireEvent.press(screen.getByTestId('send'));
    await waitFor(() => expect(engine.send).toHaveBeenCalledTimes(1));
    await settle();
    expect(release).not.toHaveBeenCalled();
    await act(async () => { finish({ transferId: TID, queued: false }); });
    await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(release).toHaveBeenCalledWith(['t-a.jpg', 't-b.mov']);
  });

  it('a rejected simple send releases nothing', async () => {
    const h = host();
    const release = jest.fn<Promise<void>, [string[]]>(async () => {});
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'send').mockRejectedValue(new Error('no'));
    mount(engine, { ...h, media: { ...h.media, release } });
    await screen.findByText('Nothing here yet');
    await stage();
    fireEvent.press(screen.getByTestId('send'));
    await screen.findByText('That send did not go through');
    expect(release).not.toHaveBeenCalled();
  });

  it('removing a staged ref releases it', async () => {
    const h = host();
    const release = jest.fn<Promise<void>, [string[]]>(async () => {});
    mount(fakeEngine([peer]), { ...h, media: { ...h.media, release } });
    await screen.findByText('Nothing here yet');
    await stage();
    fireEvent.press(screen.getByTestId('remove-media-t-a.jpg'));
    expect(release).toHaveBeenCalledWith(['t-a.jpg']);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('unmounting with staged refs releases them', async () => {
    const h = host();
    const release = jest.fn<Promise<void>, [string[]]>(async () => {});
    const { unmount } = mount(fakeEngine([peer]), { ...h, media: { ...h.media, release } });
    await screen.findByText('Nothing here yet');
    await stage();
    unmount();
    expect(release).toHaveBeenCalledWith(['t-a.jpg', 't-b.mov']);
  });

  it('a release that rejects or throws breaks nothing', async () => {
    const h = host();
    const release = jest.fn<Promise<void>, [string[]]>(() => { throw new Error('sync'); });
    mount(fakeEngine([peer]), { ...h, media: { ...h.media, release } });
    await screen.findByText('Nothing here yet');
    await stage();
    fireEvent.press(screen.getByTestId('remove-media-t-a.jpg'));
    expect(screen.queryByText('a.jpg')).toBeNull();
    release.mockRejectedValue(new Error('async'));
    fireEvent.press(screen.getByTestId('remove-media-t-b.mov'));
    await settle();
    expect(screen.queryByText('b.mov')).toBeNull();
  });

  it('a photo picked during the send stays staged after the send', async () => {
    const h = host();
    const engine = fakeEngine([peer]);
    let finish: (v: { transferId: string; queued: boolean }) => void = () => {};
    jest.spyOn(engine, 'send').mockImplementation(() => new Promise((r) => { finish = r; }));
    mount(engine, h);
    await screen.findByText('Nothing here yet');
    await stage();
    // The second pick starts before the send and ends during the send.
    let pickDone: (r: MediaRef[]) => void = () => {};
    h.media.pick.mockImplementationOnce(() => new Promise<MediaRef[]>((r) => { pickDone = r; }));
    fireEvent.press(screen.getByTestId('pick-files'));
    fireEvent.press(screen.getByTestId('pick-menu-photos'));
    fireEvent.press(screen.getByTestId('send'));
    await waitFor(() => expect(engine.send).toHaveBeenCalledTimes(1));
    await act(async () => { pickDone(refs('c.png')); });
    await screen.findByText('c.png');
    await act(async () => { finish({ transferId: TID, queued: false }); });
    await waitFor(() => expect(screen.queryByText('a.jpg')).toBeNull());
    expect(screen.getByText('c.png')).toBeTruthy();
  });

  it('the remove chips are disabled while sending', async () => {
    const h = host();
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'send').mockImplementation(() => new Promise(() => {}));
    mount(engine, h);
    await screen.findByText('Nothing here yet');
    await stage();
    fireEvent.press(screen.getByTestId('send'));
    await waitFor(() => expect(engine.send).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('remove-media-t-a.jpg')).toBeDisabled();
    fireEvent.press(screen.getByTestId('remove-media-t-a.jpg'));
    expect(screen.getByText('a.jpg')).toBeTruthy();
  });

  it('a good send clears the earlier media error', async () => {
    const h = host();
    h.media.materialize.mockRejectedValueOnce(new Error('E_SOURCE_GONE'));
    mount(fakeEngine([peer]), h);
    await screen.findByText('Nothing here yet');
    await stage();
    fireEvent.press(screen.getByTestId('send'));
    await screen.findByText('Some items can no longer be read. Pick them again.');
    fireEvent.press(screen.getByTestId('send'));
    await waitFor(() => expect(screen.queryByTestId('pick-error')).toBeNull());
  });

  it('a throw from fits shows the prepare text and sends nothing', async () => {
    const h = host();
    h.media.fits.mockRejectedValue(new Error('boom'));
    const engine = fakeEngine([peer]);
    const send = jest.spyOn(engine, 'send');
    mount(engine, h);
    await screen.findByText('Nothing here yet');
    await stage();
    fireEvent.press(screen.getByTestId('send'));
    expect(await screen.findByText('Daak could not prepare a file for sending.')).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByText('Large selection is not supported yet')).toBeNull();
  });

  it('two send presses in the same tick send once', async () => {
    const h = host();
    const engine = fakeEngine([peer]);
    const send = jest.spyOn(engine, 'send');
    mount(engine, h);
    await screen.findByText('Nothing here yet');
    await stage();
    const btn = screen.getByTestId('send');
    await act(async () => { fireEvent.press(btn); fireEvent.press(btn); });
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a cancelled pick changes nothing', async () => {
    const h = host();
    h.media.pick.mockResolvedValue([]);
    mount(fakeEngine([peer]), h);
    await screen.findByText('Nothing here yet');
    fireEvent.press(screen.getByTestId('pick-files'));
    fireEvent.press(screen.getByTestId('pick-menu-photos'));
    await waitFor(() => expect(h.media.pick).toHaveBeenCalledTimes(1));
    await settle();
    expect(screen.getByTestId('send')).toBeDisabled();
    expect(screen.queryByTestId('pick-error')).toBeNull();
  });
});

// Task 10c: a selection that does not fit starts a large send.
describe('ThreadScreen large selection', () => {
  afterEach(async () => { await settle(0); });

  const refs = (...names: string[]) => names.map((n) => ({ token: `t-${n}`, name: n, size: 10 }));
  const host = () => {
    const media = {
      pick: jest.fn<Promise<MediaRef[]>, []>(async () => refs('a.jpg', 'b.mov')),
      materialize: jest.fn<Promise<string>, [string]>(async (t) => `/cache/daak-send/${t}`),
      fits: jest.fn<Promise<boolean>, [MediaRef[]]>(async () => false),
      startLarge: jest.fn<Promise<void>, [string, MediaRef[]]>(async () => {}),
    };
    return {
      media,
      onPickFiles: jest.fn(async () => [] as string[]),
      onPickFolder: jest.fn(async (): Promise<string | null> => null),
      discardPickedCopy: jest.fn(async () => {}),
    };
  };
  const stage = async () => {
    fireEvent.press(screen.getByTestId('pick-files'));
    fireEvent.press(screen.getByTestId('pick-menu-photos'));
    return screen.findByText('a.jpg');
  };

  it('a selection that does not fit calls startLarge with the staged refs and removes them', async () => {
    const h = host();
    mount(fakeEngine([peer]), h);
    await screen.findByText('Nothing here yet');
    await stage();
    fireEvent.press(screen.getByTestId('send'));
    await waitFor(() => expect(h.media.startLarge).toHaveBeenCalledTimes(1));
    expect(h.media.startLarge).toHaveBeenCalledWith(peer.deviceId, refs('a.jpg', 'b.mov'));
    expect(h.media.materialize).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText('a.jpg')).toBeNull());
    expect(screen.queryByText('b.mov')).toBeNull();
  });

  it('a large send does not release the refs: the driver owns them, also after an unmount', async () => {
    const h = host();
    const release = jest.fn<Promise<void>, [string[]]>(async () => {});
    let finish: () => void = () => {};
    h.media.startLarge.mockImplementation(() => new Promise<void>((r) => { finish = r; }));
    const { unmount } = mount(fakeEngine([peer]), { ...h, media: { ...h.media, release } });
    await screen.findByText('Nothing here yet');
    await stage();
    fireEvent.press(screen.getByTestId('send'));
    await waitFor(() => expect(h.media.startLarge).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => { finish(); });
    await settle();
    expect(release).not.toHaveBeenCalled();
  });

  it('a large selection also sends the plain files and the note once', async () => {
    const h = host();
    const engine = fakeEngine([peer]);
    const send = jest.spyOn(engine, 'send');
    mount(engine, { ...h, initialFiles: ['/Users/d/x.pdf'] });
    await screen.findByText('Nothing here yet');
    await stage();
    fireEvent.changeText(screen.getByPlaceholderText('Or type a note'), 'hello');
    fireEvent.press(screen.getByTestId('send'));
    await waitFor(() => expect(h.media.startLarge).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith({ peerDeviceId: peer.deviceId, files: ['/Users/d/x.pdf'] });
    expect(send).toHaveBeenCalledWith({ peerDeviceId: peer.deviceId, text: 'hello' });
  });

  it('PLAN_BUSY shows its text and keeps the refs', async () => {
    const h = host();
    h.media.startLarge.mockRejectedValue(new Error('PLAN_BUSY'));
    mount(fakeEngine([peer]), h);
    await screen.findByText('Nothing here yet');
    await stage();
    fireEvent.press(screen.getByTestId('send'));
    expect(await screen.findByText('A large send is already running for this device.')).toBeTruthy();
    expect(screen.getByText('a.jpg')).toBeTruthy();
    expect(screen.getByText('b.mov')).toBeTruthy();
  });

  it('a failed startLarge keeps the refs even when plain files were sent first', async () => {
    const h = host();
    h.media.startLarge.mockRejectedValue(new Error('PLAN_BUSY'));
    const engine = fakeEngine([peer]);
    const send = jest.spyOn(engine, 'send');
    mount(engine, { ...h, initialFiles: ['/Users/d/x.pdf'] });
    await screen.findByText('Nothing here yet');
    await stage();
    fireEvent.press(screen.getByTestId('send'));
    expect(await screen.findByText('A large send is already running for this device.')).toBeTruthy();
    // The plain file went out. The photo refs stay staged, so the user can try again.
    expect(send).toHaveBeenCalledWith({ peerDeviceId: peer.deviceId, files: ['/Users/d/x.pdf'] });
    expect(screen.getByText('a.jpg')).toBeTruthy();
    expect(screen.getByText('b.mov')).toBeTruthy();
  });

  it('PLAN_TOO_LARGE shows its text', async () => {
    const h = host();
    h.media.startLarge.mockRejectedValue(new Error('PLAN_TOO_LARGE'));
    mount(fakeEngine([peer]), h);
    await screen.findByText('Nothing here yet');
    await stage();
    fireEvent.press(screen.getByTestId('send'));
    expect(await screen.findByText('Too many photos for one send. Pick fewer.')).toBeTruthy();
    expect(screen.getByText('a.jpg')).toBeTruthy();
  });

  it('a NO_SPACE error shows the photo no-space text', async () => {
    const h = host();
    h.media.startLarge.mockRejectedValue(new Error('NO_SPACE:2254857830'));
    mount(fakeEngine([peer]), h);
    await screen.findByText('Nothing here yet');
    await stage();
    fireEvent.press(screen.getByTestId('send'));
    expect(
      await screen.findByText('Not enough space to prepare these photos. Free some space and try again.'),
    ).toBeTruthy();
    expect(screen.getByText('a.jpg')).toBeTruthy();
  });

  it('any other error shows the generic text', async () => {
    const h = host();
    h.media.startLarge.mockRejectedValue(new Error('boom'));
    mount(fakeEngine([peer]), h);
    await screen.findByText('Nothing here yet');
    await stage();
    fireEvent.press(screen.getByTestId('send'));
    expect(await screen.findByText('Daak could not prepare a file for sending.')).toBeTruthy();
    expect(screen.getByText('a.jpg')).toBeTruthy();
  });

  it('without startLarge the toast is unchanged', async () => {
    const h = host();
    const { startLarge: _unused, ...media } = h.media;
    const engine = fakeEngine([peer]);
    const send = jest.spyOn(engine, 'send');
    mount(engine, { ...h, media });
    await screen.findByText('Nothing here yet');
    await stage();
    fireEvent.press(screen.getByTestId('send'));
    expect(await screen.findByText('Large selection is not supported yet')).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByText('a.jpg')).toBeTruthy();
  });

  it('a refs list picked while startLarge runs stays staged', async () => {
    const h = host();
    let finish: () => void = () => {};
    h.media.startLarge.mockImplementation(() => new Promise<void>((r) => { finish = r; }));
    mount(fakeEngine([peer]), h);
    await screen.findByText('Nothing here yet');
    await stage();
    let pickDone: (r: MediaRef[]) => void = () => {};
    h.media.pick.mockImplementationOnce(() => new Promise<MediaRef[]>((r) => { pickDone = r; }));
    fireEvent.press(screen.getByTestId('pick-files'));
    fireEvent.press(screen.getByTestId('pick-menu-photos'));
    fireEvent.press(screen.getByTestId('send'));
    await waitFor(() => expect(h.media.startLarge).toHaveBeenCalledTimes(1));
    await act(async () => { pickDone(refs('c.png')); });
    await screen.findByText('c.png');
    await act(async () => { finish(); });
    await waitFor(() => expect(screen.queryByText('a.jpg')).toBeNull());
    expect(screen.getByText('c.png')).toBeTruthy();
  });
});

describe('ThreadScreen batch row', () => {
  const plan = (p: Partial<BatchRowStatus> = {}): BatchRowStatus => ({
    share: 'cc'.repeat(16), batch: 2, of: 5, paused: false, remaining: 30, bytesDone: 50, bytesTotal: 200, ...p,
  });
  function mountBatch(initial: BatchRowStatus | null, extra: { retry?: () => Promise<void> | void; stop?: () => Promise<void> | void } = {}) {
    let current = initial;
    const subs = new Set<(peerId: string) => void>();
    const unsub = jest.fn();
    const batch = {
      status: jest.fn((_id: string) => current),
      retry: jest.fn(extra.retry ?? (async () => {})),
      stop: jest.fn(extra.stop ?? (async () => {})),
      subscribe: jest.fn((cb: (peerId: string) => void) => { subs.add(cb); return () => { subs.delete(cb); unsub(); }; }),
    };
    const engine = fakeEngine([peer]);
    const utils = mount(engine, { batch });
    const set = (n: BatchRowStatus | null, peerId = peer.deviceId) => {
      current = n;
      act(() => { subs.forEach((cb) => cb(peerId)); });
    };
    return { batch, subs, unsub, set, engine, ...utils };
  }

  it('no row without a plan', async () => {
    mountBatch(null);
    await screen.findByText('Nothing here yet');
    expect(screen.queryByTestId('batch-row')).toBeNull();
  });

  it('the running row shows remaining, batch and of', async () => {
    mountBatch(plan());
    expect(await screen.findByText('30 more waiting - batch 2 of 5')).toBeTruthy();
    expect(screen.getByTestId('batch-row').props.accessibilityLabel).toBe('30 more waiting - batch 2 of 5');
    expect(screen.queryByTestId('batch-retry')).toBeNull();
  });

  it('a last batch with no remaining items shows Sending batch k of m', async () => {
    mountBatch(plan({ batch: 5, remaining: 0 }));
    expect(await screen.findByText('Sending batch 5 of 5')).toBeTruthy();
  });

  it('the bar value follows bytesDone over bytesTotal and a total of 0 draws no bar', async () => {
    const { set } = mountBatch(plan({ bytesDone: 50, bytesTotal: 200 }));
    const bar = await screen.findByTestId('batch-bar');
    expect(bar.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 25 });
    set(plan({ bytesDone: 500, bytesTotal: 200 }));
    expect(screen.getByTestId('batch-bar').props.accessibilityValue.now).toBe(100);
    set(plan({ bytesDone: 0, bytesTotal: 0 }));
    expect(screen.queryByTestId('batch-bar')).toBeNull();
    expect(screen.getByTestId('batch-row')).toBeTruthy();
  });

  it('the paused row shows the title and the body for NO_SPACE with the size', async () => {
    mountBatch(plan({ paused: true, error: 'NO_SPACE', neededBytes: 3 * 1024 ** 3 }));
    expect(await screen.findByText('Batch 2 did not send')).toBeTruthy();
    expect(screen.getByText('Not enough space for this batch. Free 3.0 GB and tap Retry.')).toBeTruthy();
    expect(screen.queryByTestId('batch-bar')).toBeNull();
  });

  it('the paused row says some space when neededBytes is missing', async () => {
    mountBatch(plan({ paused: true, error: 'NO_SPACE' }));
    expect(await screen.findByText('Not enough space for this batch. Free some space and tap Retry.')).toBeTruthy();
  });

  it('the paused row shows the PLAN_LOST text', async () => {
    mountBatch(plan({ paused: true, error: 'PLAN_LOST' }));
    expect(await screen.findByText('Some items can no longer be read. Pick them again.')).toBeTruthy();
  });

  it('the paused row shows the CANCELED and FAILED texts', async () => {
    const { set } = mountBatch(plan({ paused: true, error: 'CANCELED' }));
    expect(await screen.findByText('This batch was canceled.')).toBeTruthy();
    set(plan({ paused: true, error: 'FAILED' }));
    expect(screen.getByText('Daak could not send this batch.')).toBeTruthy();
  });

  it('Retry and Stop call their props with the peer id and are disabled while the call runs', async () => {
    let finish: () => void = () => {};
    const { batch } = mountBatch(plan({ paused: true, error: 'FAILED' }), {
      retry: () => new Promise<void>((r) => { finish = r; }),
    });
    fireEvent.press(await screen.findByTestId('batch-retry'));
    expect(batch.retry).toHaveBeenCalledWith(peer.deviceId);
    fireEvent.press(screen.getByTestId('batch-retry'));
    fireEvent.press(screen.getByTestId('batch-stop'));
    expect(batch.retry).toHaveBeenCalledTimes(1);
    expect(batch.stop).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    await act(async () => { fireEvent.press(screen.getByTestId('batch-stop')); });
    expect(batch.stop).toHaveBeenCalledWith(peer.deviceId);
  });

  // D7: the bytes of the batch on the wire move the bar, and the row says why
  // when it has no speed.
  it('the running row adds the live bytes of the batch transfer to the bar', async () => {
    const { engine } = mountBatch(plan({ bytesDone: 50, bytesTotal: 200, transferId: TID }));
    await screen.findByTestId('batch-bar');
    expect(screen.getByTestId('batch-bar').props.accessibilityValue.now).toBe(25);
    emit(engine, { type: 'transfer.progress', transferId: TID, bytesDone: 50, bytesTotal: 100 } as DaakEvent);
    expect(screen.getByTestId('batch-bar').props.accessibilityValue.now).toBe(50);
  });

  it('a running row with no transfer on the wire says that the next batch is in preparation', async () => {
    mountBatch(plan());
    expect(await screen.findByText('Daak prepares the next batch.')).toBeTruthy();
  });

  it('a running row with a transfer and no speed yet says so', async () => {
    mountBatch(plan({ transferId: TID }));
    expect(await screen.findByText('No speed yet.')).toBeTruthy();
  });

  it('a running row with a transfer and an offline peer says that Daak waits for the peer', async () => {
    const off: DeviceInfo = { ...peer, online: false, presence: 'offline' };
    const batch = {
      status: jest.fn(() => plan({ transferId: TID })),
      retry: jest.fn(async () => {}),
      stop: jest.fn(async () => {}),
      subscribe: jest.fn(() => () => {}),
    };
    mount(fakeEngine([off]), { batch });
    expect(await screen.findByText('Daak waits for Pixel 9.')).toBeTruthy();
  });

  it('the running row has a Stop that calls stop with the peer id and is disabled while the call runs', async () => {
    let finish: () => void = () => {};
    const { batch } = mountBatch(plan(), { stop: () => new Promise<void>((r) => { finish = r; }) });
    const btn = await screen.findByTestId('batch-stop-running');
    expect(screen.queryByTestId('batch-retry')).toBeNull();
    fireEvent.press(btn);
    expect(batch.stop).toHaveBeenCalledWith(peer.deviceId);
    expect(screen.getByTestId('batch-stop-running')).toBeDisabled();
    fireEvent.press(screen.getByTestId('batch-stop-running'));
    expect(batch.stop).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    expect(screen.getByTestId('batch-stop-running')).not.toBeDisabled();
  });

  it('the row updates when the subscribe callback fires and unsubscribes on unmount', async () => {
    const { set, unsub, subs, unmount } = mountBatch(plan());
    await screen.findByText('30 more waiting - batch 2 of 5');
    set(plan({ batch: 3, remaining: 10 }));
    expect(screen.getByText('10 more waiting - batch 3 of 5')).toBeTruthy();
    set(plan({ batch: 4, remaining: 1 }), 'ff'.repeat(16));
    expect(screen.getByText('10 more waiting - batch 3 of 5')).toBeTruthy();
    unmount();
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(subs.size).toBe(0);
  });

  it('the row disappears when the status becomes null', async () => {
    const { set } = mountBatch(plan({ paused: true, error: 'FAILED' }));
    await screen.findByTestId('batch-row');
    set(null);
    expect(screen.queryByTestId('batch-row')).toBeNull();
  });

  it('the row has no file names', async () => {
    const engine = fakeEngine([peer]);
    mount(engine, {
      batch: {
        status: () => plan({ paused: true, error: 'NO_SPACE', neededBytes: 1024 ** 3 }),
        retry: jest.fn(), stop: jest.fn(), subscribe: () => () => {},
      },
    });
    const row = await screen.findByTestId('batch-row');
    const text = JSON.stringify(row.props.accessibilityLabel) + JSON.stringify(within(row).queryAllByText(/\.(jpg|png|mov|heic)/i));
    expect(text).not.toMatch(/\.(jpg|png|mov|heic)/i);
  });

  it('no batch prop shows no row (desktop)', async () => {
    mount(fakeEngine([peer]));
    await screen.findByText('Nothing here yet');
    expect(screen.queryByTestId('batch-row')).toBeNull();
  });
});
