import { act, renderHook } from '@testing-library/react-native';
import type { DaakEngine, DaakEvent, TransferSummary } from '@daak/core';
import { fakeEngine } from '../testing/fakeEngine';
import { PANEL_POLL_MS, usePanelTransfer } from './usePanelTransfer';

const TID = 'tt'.repeat(16);
const PEER = 'aa'.repeat(16);
const row = (over: Partial<TransferSummary> = {}): TransferSummary => ({
  transferId: TID,
  peerDeviceId: PEER,
  direction: 'out',
  kind: 'media',
  state: 'active',
  bytesDone: 0,
  bytesTotal: 0,
  itemCount: 1,
  updatedAt: 10,
  ...over,
});
const emit = (engine: DaakEngine, e: DaakEvent) =>
  act(() => {
    (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers.forEach((h) => h(e));
  });
const flush = () => act(async () => {});

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('usePanelTransfer', () => {
  // Review Focus 5. A mount adopts a running transfer that the panel did not start.
  it('adopts the newest running outbound transfer on mount', async () => {
    const engine = fakeEngine();
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([row({ updatedAt: 3 }), row({ transferId: 'zz'.repeat(16), updatedAt: 8 })]);
    const { result } = renderHook(() => usePanelTransfer(engine));
    await flush();
    expect(result.current.send).toEqual({ transferId: 'zz'.repeat(16), peerDeviceId: PEER, label: '' });
    expect(result.current.row?.state).toBe('active');
  });

  it('adopts nothing when no outbound transfer runs', async () => {
    const engine = fakeEngine();
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([row({ state: 'done' }), row({ direction: 'in' })]);
    const { result } = renderHook(() => usePanelTransfer(engine));
    await flush();
    expect(result.current.send).toBeNull();
  });

  it('follows its own transfer after begin and polls while it runs', async () => {
    const engine = fakeEngine();
    const list = jest.spyOn(engine, 'listTransfers').mockResolvedValue([]);
    const { result } = renderHook(() => usePanelTransfer(engine));
    await flush();
    list.mockResolvedValue([row({ bytesDone: 5, bytesTotal: 10 })]);
    act(() => result.current.begin({ transferId: TID, peerDeviceId: PEER, label: 'a.pdf' }));
    await flush();
    expect(result.current.row?.bytesDone).toBe(5);
    list.mockClear();
    list.mockResolvedValue([row({ bytesDone: 9, bytesTotal: 10 })]);
    await act(async () => {
      jest.advanceTimersByTime(PANEL_POLL_MS);
    });
    expect(list).toHaveBeenCalled();
    expect(result.current.row?.bytesDone).toBe(9);
  });

  it('stops polling when the transfer is done', async () => {
    const engine = fakeEngine();
    const list = jest.spyOn(engine, 'listTransfers').mockResolvedValue([row({ state: 'done', bytesTotal: 10 })]);
    const { result } = renderHook(() => usePanelTransfer(engine));
    await flush();
    act(() => result.current.begin({ transferId: TID, peerDeviceId: PEER, label: 'a.pdf' }));
    await flush();
    expect(result.current.row?.state).toBe('done');
    list.mockClear();
    await act(async () => {
      jest.advanceTimersByTime(PANEL_POLL_MS * 5);
    });
    expect(list).not.toHaveBeenCalled();
  });

  it('refetches on a transfer event and keeps the failure text', async () => {
    const engine = fakeEngine();
    const list = jest.spyOn(engine, 'listTransfers').mockResolvedValue([]);
    const { result } = renderHook(() => usePanelTransfer(engine));
    await flush();
    act(() => result.current.begin({ transferId: TID, peerDeviceId: PEER, label: 'a.pdf' }));
    list.mockClear();
    emit(engine, { type: 'transfer.failed', transferId: TID, error: 'peer went away' });
    await flush();
    expect(list).toHaveBeenCalled();
    expect(result.current.failure).toBe('peer went away');
  });

  it('ignores the failure text of another transfer', async () => {
    const engine = fakeEngine();
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([]);
    const { result } = renderHook(() => usePanelTransfer(engine));
    await flush();
    act(() => result.current.begin({ transferId: TID, peerDeviceId: PEER, label: 'a.pdf' }));
    emit(engine, { type: 'transfer.failed', transferId: 'other', error: 'not mine' });
    await flush();
    expect(result.current.failure).toBeNull();
  });

  it('stop cancels in the engine and clears', async () => {
    const engine = fakeEngine();
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([]);
    const cancel = jest.spyOn(engine, 'cancel');
    const { result } = renderHook(() => usePanelTransfer(engine));
    await flush();
    act(() => result.current.begin({ transferId: TID, peerDeviceId: PEER, label: 'a.pdf' }));
    let message: string | null = 'unset';
    await act(async () => {
      message = await result.current.stop();
    });
    expect(cancel).toHaveBeenCalledWith(TID);
    expect(message).toBeNull();
    expect(result.current.send).toBeNull();
  });

  it('keeps the transfer and returns the message when cancel fails', async () => {
    const engine = fakeEngine();
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([]);
    jest.spyOn(engine, 'cancel').mockRejectedValue(new Error('too late'));
    const { result } = renderHook(() => usePanelTransfer(engine));
    await flush();
    act(() => result.current.begin({ transferId: TID, peerDeviceId: PEER, label: 'a.pdf' }));
    let message: string | null = null;
    await act(async () => {
      message = await result.current.stop();
    });
    expect(message).toBe('too late');
    expect(result.current.send).not.toBeNull();
  });

  // A poll that is in flight when stop clears the transfer holds a stale list.
  it('ignores a read that was in flight when stop cleared the transfer', async () => {
    const engine = fakeEngine();
    const list = jest.spyOn(engine, 'listTransfers').mockResolvedValue([]);
    const { result } = renderHook(() => usePanelTransfer(engine));
    await flush();
    act(() => result.current.begin({ transferId: TID, peerDeviceId: PEER, label: 'a.pdf' }));
    await flush();
    let release!: (rows: TransferSummary[]) => void;
    list.mockReturnValueOnce(
      new Promise<TransferSummary[]>((resolve) => {
        release = resolve;
      }),
    );
    await act(async () => {
      jest.advanceTimersByTime(PANEL_POLL_MS);
    });
    await act(async () => {
      await result.current.stop();
    });
    expect(result.current.send).toBeNull();
    await act(async () => {
      release([row()]);
    });
    expect(result.current.send).toBeNull();
    expect(result.current.row).toBeNull();
  });

  it('retry asks the engine to retry the same transfer and clears the failure', async () => {
    const engine = fakeEngine();
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([row({ state: 'failed' })]);
    const retry = jest.spyOn(engine, 'retry');
    const { result } = renderHook(() => usePanelTransfer(engine));
    await flush();
    act(() => result.current.begin({ transferId: TID, peerDeviceId: PEER, label: 'a.pdf' }));
    emit(engine, { type: 'transfer.failed', transferId: TID, error: 'x' });
    await act(async () => {
      await result.current.retry();
    });
    expect(retry).toHaveBeenCalledWith(TID);
    expect(result.current.failure).toBeNull();
  });

  it('does not cancel on unmount', async () => {
    const engine = fakeEngine();
    jest.spyOn(engine, 'listTransfers').mockResolvedValue([]);
    const cancel = jest.spyOn(engine, 'cancel');
    const { result, unmount } = renderHook(() => usePanelTransfer(engine));
    await flush();
    act(() => result.current.begin({ transferId: TID, peerDeviceId: PEER, label: 'a.pdf' }));
    unmount();
    expect(cancel).not.toHaveBeenCalled();
  });
});
