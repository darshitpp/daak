import React from 'react';
import { KeyboardAvoidingView, ScrollView } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { DaakEngine, DaakEvent, DeviceInfo, TransferSummary } from '@daak/core';
import { EngineProvider } from '../EngineContext';
import { fakeEngine } from '../testing/fakeEngine';
import { threadItem, threadPage } from '../testing/threadFixtures';
import { ToastProvider } from '../components/Toast';
import { ThreadScreen } from './ThreadScreen';

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
    expect(screen.getByLabelText('send')).toBeDisabled();
    fireEvent.changeText(screen.getByPlaceholderText('Or type a note'), '   ');
    expect(screen.getByLabelText('send')).toBeDisabled();
    fireEvent.changeText(screen.getByPlaceholderText('Or type a note'), 'hi');
    expect(screen.getByLabelText('send')).not.toBeDisabled();
  });

  it('shows a chip for each picked file and removes it on press', async () => {
    mount(fakeEngine([peer]), { onPickFiles: async () => ['/Users/d/a.pdf', '/Users/d/b.png'] });
    await screen.findByText('Nothing here yet');
    fireEvent.press(screen.getByLabelText('pick-files'));
    expect(await screen.findByText('a.pdf')).toBeTruthy();
    // The count comes as the design toast, not as a line in the composer.
    expect(screen.getByTestId('toast-text')).toHaveTextContent('2 files ready');
    fireEvent.press(screen.getByLabelText('remove-a.pdf'));
    expect(screen.queryByText('a.pdf')).toBeNull();
    expect(screen.getByText('b.png')).toBeTruthy();
  });

  it('toasts "1 file ready" for a single picked file', async () => {
    mount(fakeEngine([peer]), { onPickFiles: async () => ['/Users/d/a.pdf'] });
    await screen.findByText('Nothing here yet');
    fireEvent.press(screen.getByLabelText('pick-files'));
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
    expect(screen.queryByLabelText('pick-files')).toBeNull();
  });

  // Spec 6.3 rule 4: two transfers, files first.
  it('sends the files first and the note second, as two sends', async () => {
    const engine = fakeEngine([peer]);
    const send = jest.spyOn(engine, 'send').mockResolvedValue({ transferId: TID, queued: true });
    mount(engine, { onPickFiles: async () => ['/Users/d/a.pdf'] });
    await screen.findByText('Nothing here yet');
    fireEvent.press(screen.getByLabelText('pick-files'));
    await screen.findByText('a.pdf');
    fireEvent.changeText(screen.getByPlaceholderText('Or type a note'), 'here you go');
    fireEvent.press(screen.getByLabelText('send'));
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
    fireEvent.press(screen.getByLabelText('send'));
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
    fireEvent.press(screen.getByLabelText('send'));
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
    expect(screen.getByLabelText('send')).not.toBeDisabled();
    fireEvent.press(screen.getByLabelText('send'));
    expect(await screen.findByText('Will send when Pixel 9 is back')).toBeTruthy();
    expect(screen.queryByTestId('thread-result')).toBeNull();
  });

  it('keeps the error note and shows no toast when the send fails', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'send').mockRejectedValue(new Error('peer refused'));
    mount(engine);
    await screen.findByText('Nothing here yet');
    fireEvent.changeText(screen.getByPlaceholderText('Or type a note'), 'x');
    fireEvent.press(screen.getByLabelText('send'));
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
    fireEvent.press(screen.getByLabelText('send'));
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
    fireEvent.press(screen.getByLabelText('pick-files'));
    await screen.findByText('a.pdf');
    fireEvent.changeText(screen.getByPlaceholderText('Or type a note'), 'keep me');
    fireEvent.press(screen.getByLabelText('send'));
    expect(await screen.findByText('That send did not go through')).toBeTruthy();
    expect(screen.getByText('peer refused')).toBeTruthy();
    expect(screen.queryByText('a.pdf')).toBeNull();
    expect(screen.getByPlaceholderText('Or type a note').props.value).toBe('keep me');
    // Try again sends only the note.
    send.mockResolvedValueOnce({ transferId: TID, queued: true });
    fireEvent.press(screen.getByLabelText('thread-retry-send'));
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
    fireEvent.press(screen.getByLabelText('thread-load-older'));
    expect(await screen.findByText('older')).toBeTruthy();
    expect(spy).toHaveBeenLastCalledWith(peer.deviceId, { limit: 50, before: 'c1' });
    expect(screen.queryByLabelText('thread-load-older')).toBeNull();
  });

  it('shows an error with Try again when the thread read fails', async () => {
    const engine = fakeEngine([peer]);
    const spy = jest.spyOn(engine, 'listThread').mockRejectedValueOnce(new Error('engine not started'));
    mount(engine);
    expect(await screen.findByText('engine not started')).toBeTruthy();
    spy.mockResolvedValueOnce(threadPage([threadItem({ text: 'back' })]));
    fireEvent.press(screen.getByLabelText('thread-reload'));
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
    fireEvent.press(screen.getByLabelText('thread-load-older'));
    // 1 s is the default and this file runs beside 36 others in the gate. The
    // assertion is unchanged; only the wait is longer.
    await waitFor(() => expect(screen.queryByLabelText('thread-load-older')).toBeNull(), { timeout: 5000 });
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
    fireEvent.press(screen.getByLabelText('thread-stop-' + TID));
    expect(screen.getByText('Stop sending?')).toBeTruthy();
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.press(screen.getByLabelText('confirm-stop'));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(TID));
    // The design toast after a confirmed stop.
    expect(await screen.findByText('Sending stopped')).toBeTruthy();
  });

  it('keeps an error note and shows no toast when the engine refuses the stop', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([summary()]);
    jest.spyOn(engine, 'cancel').mockRejectedValue(new Error('too late'));
    mount(engine);
    fireEvent.press(await screen.findByLabelText('thread-stop-' + TID));
    fireEvent.press(screen.getByLabelText('confirm-stop'));
    expect(await screen.findByText('Sending did not stop')).toBeTruthy();
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('keeps sending when the user picks Keep sending', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([summary()]);
    const cancel = jest.spyOn(engine, 'cancel').mockResolvedValue();
    mount(engine);
    fireEvent.press(await screen.findByLabelText('thread-stop-' + TID));
    fireEvent.press(screen.getByLabelText('keep-sending'));
    expect(cancel).not.toHaveBeenCalled();
  });

  // Design #cd-transfer-stop: the stop sheet names the peer and this device.
  it('names the peer and this device in the stop sheet body', async () => {
    const engine = fakeEngine([peer]);
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([summary()]);
    const first = mount(engine, { deviceNoun: 'Mac' });
    fireEvent.press(await screen.findByLabelText('thread-stop-' + TID));
    expect(
      screen.getByText('Nothing has reached Pixel 9 yet. If you stop now, the items stay on this Mac.'),
    ).toBeTruthy();
    first.unmount();
    mount(engine, { deviceNoun: 'phone' });
    fireEvent.press(await screen.findByLabelText('thread-stop-' + TID));
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
    first.unmount();
    mount(fakeEngine([{ ...peer, presence: 'away' as const }]));
    expect(await screen.findByText('Pixel 9')).toBeTruthy();
    expect(screen.queryByText(/is not on this Wi-Fi/)).toBeNull();
  });

  // Review Focus 4.
  it('shows Not paired any more for a device the engine does not list', async () => {
    const engine = fakeEngine([]);
    jest.spyOn(engine, 'listThread').mockResolvedValue(threadPage([threadItem({ text: 'old history' })]));
    const { onBack } = mount(engine);
    expect(await screen.findByText('Not paired any more')).toBeTruthy();
    expect(screen.queryByText('old history')).toBeNull();
    expect(screen.queryByPlaceholderText('Or type a note')).toBeNull();
    fireEvent.press(screen.getByLabelText('thread-back'));
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
    fireEvent.press(await screen.findByLabelText('thread-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('names the bubble actions and sizes the header controls for touch', async () => {
    mount(fakeEngine([peer]));
    const back = await screen.findByLabelText('thread-back');
    expect(back.props.accessibilityRole).toBe('button');
    expect(back.props.accessibilityHint ?? back.props.accessibilityLabel).toBeTruthy();
  });
});

