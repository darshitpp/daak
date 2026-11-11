import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GIB } from './planBatches';
import { PEER, PEER2, SHARE, flush, setup } from '../test/batchDriverFakes';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const OTHER_SHARE = 'f'.repeat(32);

/** A saved plan of three one-item batches. */
function plan(over: Record<string, unknown> = {}) {
  return {
    v: 1,
    share: SHARE,
    peerId: PEER,
    platform: 'ios',
    batches: [
      { index: 1, of: 3, tokens: ['a'], bytes: GIB },
      { index: 2, of: 3, tokens: ['b'], bytes: GIB },
      { index: 3, of: 3, tokens: ['c'], bytes: GIB },
    ],
    cursor: 1,
    inflight: null,
    paused: null,
    attempt: 0,
    ...over,
  };
}

function seed(s: ReturnType<typeof setup>, p: object, share = SHARE, peer = PEER) {
  s.fe.plans.set(`${peer}|${share}`, JSON.stringify(p));
}

/** Put a row in the fake engine as if an earlier run sent it. */
async function earlierSend(s: ReturnType<typeof setup>, batch: string, attempt: number, state: string) {
  const { transferId } = await s.fe.engine.send({
    peerDeviceId: PEER,
    files: ['/old'],
    share: SHARE,
    batch,
    attempt,
  });
  s.fe.setState(transferId, state);
  s.fe.engine.send.mockClear();
  return transferId;
}

describe('resume of a saved plan', () => {
  it('resume continues at the first batch that is not done', async () => {
    const s = setup();
    seed(s, plan({ cursor: 2 }));
    await s.driver.resume([PEER]);
    await flush();
    expect(s.fe.engine.send).toHaveBeenCalledTimes(1);
    expect(s.fe.engine.send.mock.calls[0][0]).toMatchObject({ files: ['/cache/b'], batch: '2/3', share: SHARE, attempt: 0 });
    expect(s.driver.status(PEER)).toMatchObject({ batch: 2, of: 3, bytesDone: GIB, bytesTotal: 3 * GIB, remaining: 1 });
    s.driver.dispose();
  });

  it('a plan with no inflight resumes with the same attempt', async () => {
    const s = setup();
    seed(s, plan({ cursor: 2, attempt: 3 }));
    await s.driver.resume([PEER]);
    await flush();
    expect(s.fe.engine.send.mock.calls[0][0]).toMatchObject({ batch: '2/3', attempt: 3 });
    s.driver.dispose();
  });

  it('a repeated send returns the existing id (fake send returns the same transferId) and the batch is not sent twice', async () => {
    const s = setup();
    // The earlier run sent batch 1 and crashed before it saved inflight.
    const id = await earlierSend(s, '1/3', 0, 'active');
    seed(s, plan());
    await s.driver.resume([PEER]);
    await flush();
    expect(s.fe.rows.size).toBe(1);
    const saved = JSON.parse(s.fe.plans.get(`${PEER}|${SHARE}`)!);
    expect(saved.inflight).toEqual({ transferId: id, attempt: 0 });
    // The existing row ends the batch.
    s.fe.setState(id, 'done');
    s.driver.onEvent({ type: 'transfer.done', transferId: id });
    await flush();
    expect(s.driver.status(PEER)).toMatchObject({ batch: 2 });
    expect(s.fe.rows.size).toBe(2);
    s.driver.dispose();
  });

  it('a repeated send of a batch that is already done advances at once', async () => {
    const s = setup();
    await earlierSend(s, '1/3', 0, 'done');
    seed(s, plan());
    await s.driver.resume([PEER]);
    await flush();
    expect(s.fe.engine.send.mock.calls.map((c) => c[0].batch)).toEqual(['1/3', '2/3']);
    expect(s.driver.status(PEER)).toMatchObject({ batch: 2 });
    s.driver.dispose();
  });

  it('a done transfer found at resume advances the plan', async () => {
    const s = setup();
    const id = await earlierSend(s, '1/3', 0, 'done');
    seed(s, plan({ inflight: { transferId: id, attempt: 0 } }));
    await s.driver.resume([PEER]);
    await flush();
    expect(s.fe.engine.listTransfers).toHaveBeenCalledWith({ peerDeviceId: PEER });
    expect(s.fe.engine.send).toHaveBeenCalledTimes(1);
    expect(s.fe.engine.send.mock.calls[0][0]).toMatchObject({ batch: '2/3', attempt: 0 });
    s.driver.dispose();
  });

  it.each([
    ['failed', 'FAILED'],
    ['canceled', 'CANCELED'],
  ])('a %s transfer found at resume pauses the plan', async (state, error) => {
    const s = setup();
    const id = await earlierSend(s, '1/3', 0, state);
    seed(s, plan({ inflight: { transferId: id, attempt: 0 } }));
    await s.driver.resume([PEER]);
    await flush();
    expect(s.driver.status(PEER)).toMatchObject({ paused: true, error });
    expect(s.fe.engine.send).not.toHaveBeenCalled();
    s.driver.dispose();
  });

  it('an inflight transfer that is not found at resume sends the same batch with the same attempt', async () => {
    const s = setup();
    seed(s, plan({ inflight: { transferId: 'gone', attempt: 2 }, attempt: 2 }));
    await s.driver.resume([PEER]);
    await flush();
    expect(s.fe.engine.send.mock.calls[0][0]).toMatchObject({ batch: '1/3', attempt: 2 });
    s.driver.dispose();
  });

  it('a paused plan stays paused at resume', async () => {
    const s = setup();
    seed(s, plan({ paused: { error: 'NO_SPACE', neededBytes: 7 } }));
    await s.driver.resume([PEER]);
    await flush();
    expect(s.fe.engine.send).not.toHaveBeenCalled();
    expect(s.driver.status(PEER)).toMatchObject({ paused: true, error: 'NO_SPACE', neededBytes: 7 });
    s.driver.dispose();
  });

  it('an unpaired peer at resume deletes the plan and releases', async () => {
    const s = setup();
    s.fe.engine.devices.mockResolvedValue([{ deviceId: PEER, name: 'p', addr: '', paired: false }]);
    seed(s, plan());
    await s.driver.resume([PEER]);
    await flush();
    expect(s.fe.engine.deleteSendPlan).toHaveBeenCalledWith(PEER, SHARE);
    expect(s.fe.plans.size).toBe(0);
    expect(s.media.release).toHaveBeenCalledWith(['a', 'b', 'c']);
    expect(s.fe.engine.send).not.toHaveBeenCalled();
    expect(s.driver.status(PEER)).toBeNull();
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['an unknown version', JSON.stringify(plan({ v: 2 }))],
    ['a cursor out of range', JSON.stringify(plan({ cursor: 4 }))],
    ['a batch with no tokens', JSON.stringify(plan({ batches: [{ index: 1, of: 1, tokens: [], bytes: 0 }] }))],
    ['a share that is not the key', JSON.stringify(plan({ share: OTHER_SHARE }))],
    ['a plan of another peer', JSON.stringify(plan({ peerId: PEER2 }))],
  ])('an invalid or unknown-version plan is deleted (%s)', async (_what, text) => {
    const s = setup();
    s.fe.plans.set(`${PEER}|${SHARE}`, text);
    await expect(s.driver.resume([PEER])).resolves.toBeUndefined();
    await flush();
    expect(s.fe.engine.deleteSendPlan).toHaveBeenCalledWith(PEER, SHARE);
    expect(s.fe.engine.send).not.toHaveBeenCalled();
    expect(s.driver.status(PEER)).toBeNull();
  });

  it('an offline peer leaves the plan waiting with no timeout', async () => {
    const s = setup();
    s.fe.engine.devices.mockResolvedValue([
      { deviceId: PEER, name: 'p', addr: '', paired: true, online: false, presence: 'offline' } as never,
    ]);
    const id = await earlierSend(s, '1/3', 0, 'queued');
    seed(s, plan({ inflight: { transferId: id, attempt: 0 } }));
    await s.driver.resume([PEER]);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    await flush();
    expect(s.driver.status(PEER)).toMatchObject({ batch: 1, paused: false });
    expect(s.fe.plans.size).toBe(1);
    expect(s.fe.engine.send).not.toHaveBeenCalled();
    expect(s.fe.engine.cancel).not.toHaveBeenCalled();
    // The peer comes back and the batch ends.
    s.fe.setState(id, 'done');
    await vi.advanceTimersByTimeAsync(15_000);
    await flush();
    expect(s.driver.status(PEER)).toMatchObject({ batch: 2 });
    s.driver.dispose();
  });

  it('two plans for one peer keep one', async () => {
    const s = setup();
    seed(s, plan({ share: OTHER_SHARE, cursor: 3 }), OTHER_SHARE);
    seed(s, plan({ cursor: 2 }));
    await s.driver.resume([PEER]);
    await flush();
    expect(s.fe.engine.deleteSendPlan).toHaveBeenCalledTimes(1);
    expect(s.fe.engine.deleteSendPlan).toHaveBeenCalledWith(PEER, OTHER_SHARE);
    expect(s.driver.status(PEER)).toMatchObject({ share: SHARE, batch: 2 });
    expect(s.fe.engine.send).toHaveBeenCalledTimes(1);
    s.driver.dispose();
  });

  it('resume of two peers runs one plan for each', async () => {
    const s = setup();
    seed(s, plan());
    seed(s, plan({ peerId: PEER2 }), SHARE, PEER2);
    await s.driver.resume([PEER, PEER2]);
    await flush();
    expect(s.fe.engine.send.mock.calls.map((c) => c[0].peerDeviceId).sort()).toEqual([PEER, PEER2]);
    s.driver.dispose();
  });

  it('a peer with no plan gets no action', async () => {
    const s = setup();
    await s.driver.resume([PEER]);
    expect(s.driver.status(PEER)).toBeNull();
    expect(s.fe.engine.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('after each send and each end the driver saves the plan', async () => {
    const s = setup();
    seed(s, plan({ cursor: 3 }));
    await s.driver.resume([PEER]);
    await flush();
    const saved = JSON.parse(s.fe.plans.get(`${PEER}|${SHARE}`)!);
    expect(saved.inflight).toEqual({ transferId: 't1', attempt: 0 });
    s.fe.setState('t1', 'done');
    s.driver.onEvent({ type: 'transfer.done', transferId: 't1' });
    await flush();
    expect(s.fe.plans.size).toBe(0);
    expect(s.media.release).toHaveBeenCalledWith(['a', 'b', 'c']);
    s.driver.dispose();
  });
});
