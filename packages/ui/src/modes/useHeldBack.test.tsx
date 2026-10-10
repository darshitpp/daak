import { act, renderHook } from '@testing-library/react-native';
import type { DaakEngine, DaakEvent, QuarantineReport } from '@daak/core';
import { fakeEngine } from '../testing/fakeEngine';
import { HELD_POLL_MS, useHeldBack } from './useHeldBack';

const report = (name: string): QuarantineReport => ({
  transferId: 'tt'.repeat(16),
  itemIndex: 0,
  name,
  size: 4_400_000,
  senderName: 'Kitchen Tablet',
  senderDeviceId: 'bb'.repeat(16),
  receivedAt: 1_700_000_000,
  expected: '7f3a91c204be' + '0'.repeat(52),
  actual: '7f3a91c204c9' + '0'.repeat(52),
  heldPath: '/tmp/x',
});
const emit = (engine: DaakEngine, e: DaakEvent) =>
  act(() => {
    (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers.forEach((h) => h(e));
  });
const flush = () => act(async () => {});

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('useHeldBack', () => {
  it('is null when nothing is held', async () => {
    const engine = fakeEngine();
    const { result } = renderHook(() => useHeldBack(engine));
    await flush();
    expect(result.current).toBeNull();
  });

  it('returns the newest report, which is the first of the list', async () => {
    const engine = fakeEngine();
    jest.spyOn(engine, 'listQuarantineReports').mockResolvedValue([report('new.jpg'), report('old.jpg')]);
    const { result } = renderHook(() => useHeldBack(engine));
    await flush();
    expect(result.current?.name).toBe('new.jpg');
  });

  // Review Focus 5. A held-back item arrives while the panel is open.
  it('shows a report that arrives after the mount, on a transfer event', async () => {
    const engine = fakeEngine();
    const list = jest.spyOn(engine, 'listQuarantineReports').mockResolvedValue([]);
    const { result } = renderHook(() => useHeldBack(engine));
    await flush();
    expect(result.current).toBeNull();
    list.mockResolvedValue([report('late.jpg')]);
    emit(engine, { type: 'transfer.item', transferId: 'tt'.repeat(16), itemIndex: 0, state: 'quarantined' });
    await flush();
    expect(result.current?.name).toBe('late.jpg');
  });

  // The user deletes the held file in the full window. No event reaches this
  // hook for that, so the poll clears the card.
  it('drops the report on the next poll after the item is gone', async () => {
    const engine = fakeEngine();
    const list = jest.spyOn(engine, 'listQuarantineReports').mockResolvedValue([report('a.jpg')]);
    const { result } = renderHook(() => useHeldBack(engine));
    await flush();
    expect(result.current?.name).toBe('a.jpg');
    list.mockResolvedValue([]);
    await act(async () => {
      jest.advanceTimersByTime(HELD_POLL_MS);
    });
    expect(result.current).toBeNull();
  });

  it('keeps the last report when a read fails', async () => {
    const engine = fakeEngine();
    const list = jest.spyOn(engine, 'listQuarantineReports').mockResolvedValue([report('a.jpg')]);
    const { result } = renderHook(() => useHeldBack(engine));
    await flush();
    list.mockRejectedValue(new Error('db busy'));
    await act(async () => {
      jest.advanceTimersByTime(HELD_POLL_MS);
    });
    expect(result.current?.name).toBe('a.jpg');
  });

  it('stops polling on unmount', async () => {
    const engine = fakeEngine();
    const list = jest.spyOn(engine, 'listQuarantineReports').mockResolvedValue([]);
    const { unmount } = renderHook(() => useHeldBack(engine));
    await flush();
    unmount();
    list.mockClear();
    await act(async () => {
      jest.advanceTimersByTime(HELD_POLL_MS * 3);
    });
    expect(list).not.toHaveBeenCalled();
  });
});
