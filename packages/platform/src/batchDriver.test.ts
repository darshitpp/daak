import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GIB } from './planBatches';
import { PLAN_MAX_BYTES } from './batchDriver';
import { PEER, PEER2, SHARE, deferred, flush, ref, setup } from '../test/batchDriverFakes';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const twoBatches = [ref('a', 3), ref('b', 3)];

/** Send the done event for a transfer after the fake row says done. */
async function finish(s: ReturnType<typeof setup>, id: string) {
  s.fe.setState(id, 'done');
  s.driver.onEvent({ type: 'transfer.done', transferId: id });
  await flush();
}

describe('the batch driver', () => {
  it('a plan sends batch 1, discards its copies when send resolves, waits for the done of that transferId, then sends batch 2', async () => {
    const s = setup();
    const gate = deferred<{ transferId: string; queued: boolean }>();
    const realSend = s.fe.engine.send.getMockImplementation()!;
    s.fe.engine.send.mockImplementationOnce(async (req) => {
      const r = await realSend(req);
      await gate.promise;
      return r;
    });
    const started = s.driver.start(PEER, twoBatches);
    await flush();
    expect(s.fe.engine.send).toHaveBeenCalledTimes(1);
    // The copies stay until send resolves.
    expect(s.media.discard).not.toHaveBeenCalled();
    gate.resolve({ transferId: 't1', queued: true });
    await started;
    expect(s.media.discard).toHaveBeenCalledWith('/cache/a');
    // Batch 2 waits for the end of batch 1.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.fe.engine.send).toHaveBeenCalledTimes(1);
    expect(s.media.materialize).toHaveBeenCalledTimes(1);
    await finish(s, 't1');
    expect(s.fe.engine.send).toHaveBeenCalledTimes(2);
    expect(s.fe.engine.send.mock.calls[1][0].files).toEqual(['/cache/b']);
    expect(s.media.discard).toHaveBeenCalledWith('/cache/b');
    s.driver.dispose();
  });

  it('the tag is share and k/m with attempt 0', async () => {
    const s = setup();
    await expect(s.driver.start(PEER, twoBatches)).resolves.toEqual({ share: SHARE });
    expect(s.fe.engine.send).toHaveBeenCalledWith({
      peerDeviceId: PEER,
      files: ['/cache/a'],
      share: SHARE,
      batch: '1/2',
      attempt: 0,
    });
    await finish(s, 't1');
    expect(s.fe.engine.send.mock.calls[1][0]).toMatchObject({ batch: '2/2', attempt: 0, share: SHARE });
    s.driver.dispose();
  });

  // D7: the waiting row reads the live progress of the batch on the wire.
  it('status gives the transferId of the batch on the wire, and none between batches', async () => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    expect(s.driver.status(PEER)).toMatchObject({ batch: 1, transferId: 't1' });
    await finish(s, 't1');
    expect(s.driver.status(PEER)).toMatchObject({ batch: 2, transferId: 't2' });
    s.driver.dispose();
  });

  it('a done event for another transferId does not advance', async () => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    s.driver.onEvent({ type: 'transfer.done', transferId: 'other' });
    await flush();
    expect(s.fe.engine.send).toHaveBeenCalledTimes(1);
    expect(s.driver.status(PEER)).toMatchObject({ batch: 1, of: 2 });
    s.driver.dispose();
  });

  it('the driver reads listTransfers on a done event and does not trust the event', async () => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    s.fe.setState('t1', 'active');
    s.fe.engine.listTransfers.mockClear();
    s.driver.onEvent({ type: 'transfer.done', transferId: 't1' });
    await flush();
    expect(s.fe.engine.listTransfers).toHaveBeenCalledWith({ peerDeviceId: PEER });
    expect(s.fe.engine.send).toHaveBeenCalledTimes(1);
    expect(s.driver.status(PEER)).toMatchObject({ batch: 1, paused: false });
    s.driver.dispose();
  });

  it('no action while the state is queued, paused, or active', async () => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    for (const state of ['queued', 'paused', 'active', 'awaiting_ack']) {
      s.fe.setState('t1', state);
      s.driver.onEvent({ type: 'transfer.failed', transferId: 't1', error: 'x' });
      await flush();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(s.driver.status(PEER)).toMatchObject({ batch: 1, paused: false });
    }
    expect(s.fe.engine.send).toHaveBeenCalledTimes(1);
    expect(s.fe.engine.retry).not.toHaveBeenCalled();
    s.driver.dispose();
  });

  it.each([
    ['failed', 'FAILED'],
    ['canceled', 'CANCELED'],
  ])('a %s transfer pauses the plan', async (state, error) => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    s.fe.setState('t1', state);
    s.driver.onEvent({ type: 'transfer.failed', transferId: 't1', error: 'x' });
    await flush();
    expect(s.driver.status(PEER)).toMatchObject({ paused: true, error, batch: 1 });
    expect(s.fe.engine.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(s.fe.plans.get(`${PEER}|${SHARE}`)!).paused).toEqual({ error });
    s.driver.dispose();
  });

  it('retry on a failed row calls engine.retry', async () => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    s.fe.setState('t1', 'failed');
    s.driver.onEvent({ type: 'transfer.failed', transferId: 't1', error: 'x' });
    await flush();
    await s.driver.retry(PEER);
    expect(s.fe.engine.retry).toHaveBeenCalledWith('t1');
    expect(s.fe.engine.send).toHaveBeenCalledTimes(1);
    expect(s.media.materialize).toHaveBeenCalledTimes(1);
    expect(s.driver.status(PEER)).toMatchObject({ paused: false, batch: 1 });
    // The same transfer still ends the batch.
    await finish(s, 't1');
    expect(s.fe.engine.send).toHaveBeenCalledTimes(2);
    s.driver.dispose();
  });

  it('retry on a canceled row materializes again and sends the same batch with attempt + 1', async () => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    s.fe.setState('t1', 'canceled');
    s.driver.onEvent({ type: 'transfer.failed', transferId: 't1', error: 'x' });
    await flush();
    await s.driver.retry(PEER);
    expect(s.fe.engine.retry).not.toHaveBeenCalled();
    expect(s.media.materialize).toHaveBeenCalledTimes(2);
    expect(s.fe.engine.send).toHaveBeenCalledTimes(2);
    expect(s.fe.engine.send.mock.calls[1][0]).toMatchObject({ batch: '1/2', attempt: 1, files: ['/cache/a'] });
    const saved = JSON.parse(s.fe.plans.get(`${PEER}|${SHARE}`)!);
    expect(saved.inflight).toEqual({ transferId: 't2', attempt: 1 });
    expect(saved.paused).toBeNull();
    s.driver.dispose();
  });

  it('retry does nothing while the plan is not paused', async () => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    await s.driver.retry(PEER);
    expect(s.fe.engine.send).toHaveBeenCalledTimes(1);
    expect(s.fe.engine.retry).not.toHaveBeenCalled();
    s.driver.dispose();
  });

  it('stop cancels the in-flight transfer, deletes the plan, releases the tokens', async () => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    s.onChange.mockClear();
    await s.driver.stop(PEER);
    expect(s.fe.engine.cancel).toHaveBeenCalledWith('t1');
    expect(s.fe.engine.deleteSendPlan).toHaveBeenCalledWith(PEER, SHARE);
    expect(s.fe.plans.size).toBe(0);
    expect(s.media.release).toHaveBeenCalledWith(['a', 'b']);
    expect(s.driver.status(PEER)).toBeNull();
    expect(s.onChange).toHaveBeenCalledWith(PEER);
    s.driver.dispose();
  });

  it('stop while a batch copies discards the copies and sends nothing', async () => {
    const s = setup();
    const gate = deferred<string>();
    s.media.materialize.mockImplementationOnce(() => gate.promise);
    const started = s.driver.start(PEER, [ref('a', 1), ref('b', 1)]);
    await flush();
    const stopped = s.driver.stop(PEER);
    gate.resolve('/cache/a');
    await started;
    await stopped;
    expect(s.fe.engine.send).not.toHaveBeenCalled();
    expect(s.media.discard).toHaveBeenCalledWith('/cache/a');
    expect(s.media.materialize).toHaveBeenCalledTimes(1);
    expect(s.fe.plans.size).toBe(0);
    s.driver.dispose();
  });

  it('a second start for the same peer rejects PLAN_BUSY', async () => {
    const s = setup();
    const first = s.driver.start(PEER, twoBatches);
    await expect(s.driver.start(PEER, twoBatches)).rejects.toThrow(/^PLAN_BUSY$/);
    await first;
    await expect(s.driver.start(PEER, twoBatches)).rejects.toThrow(/^PLAN_BUSY$/);
    // A saved plan from an earlier run also counts.
    const other = setup();
    await other.fe.engine.saveSendPlan(PEER, SHARE, '{}');
    await expect(other.driver.start(PEER, twoBatches)).rejects.toThrow(/^PLAN_BUSY$/);
    // Another peer can start.
    await expect(s.driver.start(PEER2, twoBatches)).resolves.toEqual({ share: SHARE });
    s.driver.dispose();
  });

  it('start lets PLAN_TOO_LARGE and NO_SPACE from planBatches reject', async () => {
    const s = setup();
    s.media.freeBytes.mockResolvedValueOnce(0);
    await expect(s.driver.start(PEER, twoBatches)).rejects.toThrow(/^NO_SPACE/);
    const refs = Array.from({ length: 1001 }, (_, i) => ref(`t${i}`, 3));
    await expect(s.driver.start(PEER, refs)).rejects.toThrow(/^PLAN_TOO_LARGE/);
    expect(s.driver.status(PEER)).toBeNull();
    expect(s.fe.engine.saveSendPlan).not.toHaveBeenCalled();
  });

  it('NO_SPACE on the first item pauses with the needed size', async () => {
    const s = setup();
    s.media.materialize.mockRejectedValueOnce(new Error('NO_SPACE:12345'));
    await s.driver.start(PEER, twoBatches);
    expect(s.driver.status(PEER)).toMatchObject({ paused: true, error: 'NO_SPACE', neededBytes: 12345, batch: 1 });
    expect(s.fe.engine.send).not.toHaveBeenCalled();
    expect(JSON.parse(s.fe.plans.get(`${PEER}|${SHARE}`)!).paused).toEqual({ error: 'NO_SPACE', neededBytes: 12345 });
  });

  it('NO_SPACE on a later item closes the batch there and moves the rest to a new batch that is persisted', async () => {
    const s = setup();
    // Batch 1 is a, b, c (3 GiB). Batch 2 is d.
    s.media.materialize.mockImplementation(async (t: string) => {
      if (t === 'c') throw new Error('NO_SPACE:99');
      return `/cache/${t}`;
    });
    await s.driver.start(PEER, [ref('a', 1), ref('b', 1), ref('c', 1), ref('d', 3)]);
    expect(s.fe.engine.send.mock.calls[0][0]).toMatchObject({ files: ['/cache/a', '/cache/b'], batch: '1/3' });
    const saved = JSON.parse(s.fe.plans.get(`${PEER}|${SHARE}`)!);
    expect(saved.batches.map((b: { index: number; of: number; tokens: string[] }) => [b.index, b.of, b.tokens])).toEqual([
      [1, 3, ['a', 'b']],
      [2, 3, ['c']],
      [3, 3, ['d']],
    ]);
    expect(s.driver.status(PEER)).toMatchObject({ batch: 1, of: 3, paused: false, remaining: 2 });
    s.media.materialize.mockImplementation(async (t: string) => `/cache/${t}`);
    await finish(s, 't1');
    expect(s.fe.engine.send.mock.calls[1][0]).toMatchObject({ files: ['/cache/c'], batch: '2/3' });
    s.driver.dispose();
  });

  it('low free space before a later item closes the batch there', async () => {
    const s = setup();
    // start, before b, before c.
    s.media.freeBytes
      .mockResolvedValueOnce(100 * GIB)
      .mockResolvedValueOnce(100 * GIB)
      .mockResolvedValueOnce(GIB);
    await s.driver.start(PEER, [ref('a', 1), ref('b', 1), ref('c', 1), ref('d', 3)]);
    expect(s.media.materialize).toHaveBeenCalledTimes(2);
    expect(s.fe.engine.send.mock.calls[0][0]).toMatchObject({ files: ['/cache/a', '/cache/b'], batch: '1/3' });
    s.driver.dispose();
  });

  it('E_SOURCE_GONE pauses with PLAN_LOST', async () => {
    const s = setup();
    s.media.materialize.mockRejectedValueOnce(new Error('E_SOURCE_GONE'));
    await s.driver.start(PEER, twoBatches);
    expect(s.driver.status(PEER)).toMatchObject({ paused: true, error: 'PLAN_LOST' });
    expect(s.fe.engine.send).not.toHaveBeenCalled();
    // The user can fix the source. Retry runs the batch again.
    await s.driver.retry(PEER);
    expect(s.fe.engine.send).toHaveBeenCalledTimes(1);
    expect(s.fe.engine.send.mock.calls[0][0]).toMatchObject({ batch: '1/2', attempt: 1 });
    s.driver.dispose();
  });

  it('a send that rejects pauses with FAILED and discards the copies', async () => {
    const s = setup();
    s.fe.engine.send.mockRejectedValueOnce(new Error('boom'));
    await s.driver.start(PEER, [ref('a', 1), ref('b', 1)]);
    expect(s.driver.status(PEER)).toMatchObject({ paused: true, error: 'FAILED' });
    expect(s.media.discard.mock.calls.map((c) => c[0]).sort()).toEqual(['/cache/a', '/cache/b']);
    expect(s.fe.plans.has(`${PEER}|${SHARE}`)).toBe(true);
    await s.driver.retry(PEER);
    expect(s.fe.engine.send).toHaveBeenCalledTimes(2);
    s.driver.dispose();
  });

  it('every materialize has a matching discard on every error path', async () => {
    const errors = ['NO_SPACE:5', 'E_SOURCE_GONE', 'NOT_DOWNLOADED', 'E_MATERIALIZE'];
    for (const err of errors) {
      for (const at of [0, 1, 2]) {
        const s = setup();
        let i = 0;
        s.media.materialize.mockImplementation(async (t: string) => {
          if (i++ === at) throw new Error(err);
          return `/cache/${t}`;
        });
        await s.driver.start(PEER, [ref('a', 1), ref('b', 1), ref('c', 1)]);
        const made = s.media.materialize.mock.results.filter((r) => r.type === 'return').length;
        // Each resolved materialize gives one path. Count the resolved ones.
        const paths = await Promise.all(
          s.media.materialize.mock.results.map((r) => (r.value as Promise<string>).catch(() => null)),
        );
        const copies = paths.filter((p): p is string => p !== null);
        expect(made).toBeGreaterThan(0);
        expect(s.media.discard.mock.calls.map((c) => c[0]).sort()).toEqual(copies.sort());
        s.driver.dispose();
      }
    }
    // A send that rejects.
    const s = setup();
    s.fe.engine.send.mockRejectedValueOnce(new Error('x'));
    await s.driver.start(PEER, [ref('a', 1), ref('b', 1)]);
    expect(s.media.discard).toHaveBeenCalledTimes(s.media.materialize.mock.calls.length);
  });

  it('the saved plan holds tokens and sizes and no names', async () => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    const text = s.fe.plans.get(`${PEER}|${SHARE}`)!;
    expect(text).not.toContain('.jpg');
    expect(text).not.toContain('/cache/');
    const saved = JSON.parse(text);
    expect(saved).toEqual({
      v: 1,
      share: SHARE,
      peerId: PEER,
      platform: 'ios',
      batches: [
        { index: 1, of: 2, tokens: ['a'], bytes: 3 * GIB },
        { index: 2, of: 2, tokens: ['b'], bytes: 3 * GIB },
      ],
      cursor: 1,
      inflight: { transferId: 't1', attempt: 0 },
      sending: null,
      paused: null,
      attempt: 0,
    });
    s.driver.dispose();
  });

  it('the plan is saved after the plan is computed, before and after send, and after each end', async () => {
    const s = setup();
    const order: string[] = [];
    const save = s.fe.engine.saveSendPlan.getMockImplementation()!;
    s.fe.engine.saveSendPlan.mockImplementation(async (p, sh, json) => {
      const j = JSON.parse(json);
      const mark = j.sending === null || j.sending === undefined ? '' : ` s${j.sending}`;
      order.push(`save c${j.cursor} ${j.inflight ? j.inflight.transferId : '-'}${mark}`);
      return save(p, sh, json);
    });
    const send = s.fe.engine.send.getMockImplementation()!;
    s.fe.engine.send.mockImplementation(async (req) => {
      order.push(`send ${req.batch}`);
      return send(req);
    });
    await s.driver.start(PEER, twoBatches);
    await finish(s, 't1');
    expect(order).toEqual([
      'save c1 -',
      'save c1 - s0',
      'send 1/2',
      'save c1 t1',
      'save c2 -',
      'save c2 - s0',
      'send 2/2',
      'save c2 t2',
    ]);
    s.driver.dispose();
  });

  it('the last batch done deletes the plan and releases the tokens', async () => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    await finish(s, 't1');
    expect(s.fe.engine.deleteSendPlan).not.toHaveBeenCalled();
    expect(s.driver.status(PEER)).toMatchObject({ batch: 2, of: 2, bytesDone: 3 * GIB, bytesTotal: 6 * GIB, remaining: 0 });
    await finish(s, 't2');
    expect(s.fe.engine.deleteSendPlan).toHaveBeenCalledWith(PEER, SHARE);
    expect(s.media.release).toHaveBeenCalledWith(['a', 'b']);
    expect(s.driver.status(PEER)).toBeNull();
    expect(s.onChange).toHaveBeenLastCalledWith(PEER);
    // A new plan for the peer can start now.
    await expect(s.driver.start(PEER, twoBatches)).resolves.toEqual({ share: SHARE });
    s.driver.dispose();
  });

  it('the poll finds a canceled transfer within 15 s', async () => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    s.fe.setState('t1', 'canceled');
    await vi.advanceTimersByTimeAsync(14_999);
    expect(s.driver.status(PEER)).toMatchObject({ paused: false });
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(s.driver.status(PEER)).toMatchObject({ paused: true, error: 'CANCELED' });
    s.driver.dispose();
  });

  it('the poll stops when no batch is in flight', async () => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    expect(vi.getTimerCount()).toBe(1);
    s.fe.setState('t1', 'failed');
    await vi.advanceTimersByTimeAsync(15_000);
    await flush();
    expect(s.driver.status(PEER)).toMatchObject({ paused: true });
    expect(vi.getTimerCount()).toBe(0);
    s.fe.engine.listTransfers.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.fe.engine.listTransfers).not.toHaveBeenCalled();
    // dispose clears a running poll.
    await s.driver.retry(PEER);
    expect(vi.getTimerCount()).toBe(1);
    s.driver.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('serialization: an event and a poll tick at the same time advance the plan once', async () => {
    const s = setup();
    await s.driver.start(PEER, [ref('a', 3), ref('b', 3), ref('c', 3)]);
    s.fe.setState('t1', 'done');
    s.driver.onEvent({ type: 'transfer.done', transferId: 't1' });
    s.driver.onEvent({ type: 'transfer.done', transferId: 't1' });
    await vi.advanceTimersByTimeAsync(15_000);
    await flush();
    expect(s.fe.engine.send).toHaveBeenCalledTimes(2);
    expect(s.driver.status(PEER)).toMatchObject({ batch: 2, of: 3 });
    s.driver.dispose();
  });

  it('the log gets no token, path, name, or share', async () => {
    const s = setup();
    s.media.materialize.mockRejectedValueOnce(new Error('E_SOURCE_GONE'));
    await s.driver.start(PEER, twoBatches);
    s.fe.engine.send.mockRejectedValueOnce(new Error('send /cache/a failed'));
    await s.driver.retry(PEER);
    const text = s.log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(s.log).toHaveBeenCalled();
    for (const bad of [SHARE, '/cache/', 'a.jpg', PEER]) expect(text).not.toContain(bad);
    s.driver.dispose();
  });
});

/** Batch 1 is x (3 GiB). Batch 2 is a (2 GiB) and b (1 GiB). */
const laterSplit = [ref('x', 3), ref('a', 2), ref('b', 1)];

/** The batch total m of each send, in send order. */
const totals = (s: ReturnType<typeof setup>) =>
  s.fe.engine.send.mock.calls.map((c) => c[0].batch!.split('/')[1]);

describe('the batch driver after the review', () => {
  it('a free-space failure discards the copies and pauses FAILED', async () => {
    const s = setup();
    // start, then before b.
    s.media.freeBytes.mockResolvedValueOnce(100 * GIB).mockRejectedValueOnce(new Error('statfs'));
    await s.driver.start(PEER, [ref('a', 1), ref('b', 1)]);
    expect(s.media.discard).toHaveBeenCalledWith('/cache/a');
    expect(s.fe.engine.send).not.toHaveBeenCalled();
    expect(s.driver.status(PEER)).toMatchObject({ paused: true, error: 'FAILED' });
    expect(JSON.parse(s.fe.plans.get(`${PEER}|${SHARE}`)!).paused).toEqual({ error: 'FAILED' });
    s.driver.dispose();
  });

  it('a throw during the send step discards the copies and pauses FAILED', async () => {
    const s = setup();
    // The split happens before c. The redraw after the split save throws once.
    s.media.freeBytes
      .mockResolvedValueOnce(100 * GIB)
      .mockResolvedValueOnce(100 * GIB)
      .mockResolvedValueOnce(GIB);
    s.media.materialize.mockImplementation(async (t: string) => {
      if (t === 'b') {
        s.onChange.mockImplementationOnce(() => {
          throw new Error('redraw');
        });
      }
      return `/cache/${t}`;
    });
    await s.driver.start(PEER, [ref('a', 1), ref('b', 1), ref('c', 1), ref('d', 3)]);
    expect(s.media.discard.mock.calls.map((c) => c[0]).sort()).toEqual(['/cache/a', '/cache/b']);
    expect(s.fe.engine.send).not.toHaveBeenCalled();
    expect(s.driver.status(PEER)).toMatchObject({ paused: true, error: 'FAILED' });
    s.driver.dispose();
  });

  it('a low-space condition in batch 2 pauses NO_SPACE with the needed size and does not split', async () => {
    // The free-space check before b.
    const s = setup();
    await s.driver.start(PEER, laterSplit);
    s.media.freeBytes.mockResolvedValueOnce(GIB);
    await finish(s, 't1');
    expect(s.fe.engine.send).toHaveBeenCalledTimes(1);
    expect(s.media.discard).toHaveBeenCalledWith('/cache/a');
    expect(s.driver.status(PEER)).toMatchObject({ batch: 2, of: 2, paused: true, error: 'NO_SPACE', neededBytes: 4 * GIB });
    const saved = JSON.parse(s.fe.plans.get(`${PEER}|${SHARE}`)!);
    expect(saved.batches.map((b: { tokens: string[] }) => b.tokens)).toEqual([['x'], ['a', 'b']]);
    expect(saved.paused).toEqual({ error: 'NO_SPACE', neededBytes: 4 * GIB });
    s.driver.dispose();

    // NO_SPACE from the copy of b.
    const t = setup();
    await t.driver.start(PEER, laterSplit);
    t.media.materialize.mockImplementation(async (tok: string) => {
      if (tok === 'b') throw new Error('NO_SPACE:99');
      return `/cache/${tok}`;
    });
    await finish(t, 't1');
    expect(t.fe.engine.send).toHaveBeenCalledTimes(1);
    expect(t.media.discard).toHaveBeenCalledWith('/cache/a');
    expect(t.driver.status(PEER)).toMatchObject({ batch: 2, of: 2, paused: true, error: 'NO_SPACE', neededBytes: 99 });
    t.driver.dispose();
  });

  it('retry sends the same batch again with attempt + 1', async () => {
    const s = setup();
    await s.driver.start(PEER, laterSplit);
    s.media.freeBytes.mockResolvedValueOnce(GIB);
    await finish(s, 't1');
    await s.driver.retry(PEER);
    expect(s.fe.engine.send).toHaveBeenCalledTimes(2);
    expect(s.fe.engine.send.mock.calls[1][0]).toMatchObject({
      batch: '2/2',
      attempt: 1,
      files: ['/cache/a', '/cache/b'],
    });
    expect(s.driver.status(PEER)).toMatchObject({ batch: 2, of: 2, paused: false });
    s.driver.dispose();
  });

  it('the first batch may be split and the plan total stays at or below 1000', async () => {
    const s = setup();
    // Batch 1 is a and b. 998 more batches of one item each: 999 batches.
    const refs = [ref('a', 1), ref('b', 1), ...Array.from({ length: 998 }, (_, i) => ref(`t${i}`, 3))];
    // start, then before b.
    s.media.freeBytes.mockResolvedValueOnce(100 * GIB).mockResolvedValueOnce(GIB);
    await s.driver.start(PEER, refs);
    expect(s.fe.engine.send.mock.calls[0][0]).toMatchObject({ files: ['/cache/a'], batch: '1/1000' });
    const saved = JSON.parse(s.fe.plans.get(`${PEER}|${SHARE}`)!);
    expect(saved.batches).toHaveLength(1000);
    expect(saved.batches[1]).toMatchObject({ index: 2, of: 1000, tokens: ['b'] });
    s.driver.dispose();
  });

  it('a split that would make more than 1000 batches pauses NO_SPACE', async () => {
    const s = setup();
    // Batch 1 is a and b. 999 more batches of one item each: 1000 batches.
    const refs = [ref('a', 1), ref('b', 1), ...Array.from({ length: 999 }, (_, i) => ref(`t${i}`, 3))];
    s.media.freeBytes.mockResolvedValueOnce(100 * GIB).mockResolvedValueOnce(GIB);
    await s.driver.start(PEER, refs);
    expect(s.fe.engine.send).not.toHaveBeenCalled();
    expect(s.media.discard).toHaveBeenCalledWith('/cache/a');
    expect(s.driver.status(PEER)).toMatchObject({ batch: 1, of: 1000, paused: true, error: 'NO_SPACE' });
    expect(JSON.parse(s.fe.plans.get(`${PEER}|${SHARE}`)!).batches).toHaveLength(1000);
    s.driver.dispose();
  });

  it('m never changes once batch 1 was sent', async () => {
    const s = setup();
    await s.driver.start(PEER, [ref('x', 3), ref('a', 2), ref('b', 1), ref('c', 3)]);
    // Batch 2: low space before b.
    s.media.freeBytes.mockResolvedValueOnce(GIB);
    await finish(s, 't1');
    expect(s.driver.status(PEER)).toMatchObject({ paused: true, error: 'NO_SPACE' });
    // The retry of batch 2: NO_SPACE from the copy of b.
    s.media.materialize.mockImplementationOnce(async () => '/cache/a').mockRejectedValueOnce(new Error('NO_SPACE:5'));
    await s.driver.retry(PEER);
    expect(s.driver.status(PEER)).toMatchObject({ paused: true, error: 'NO_SPACE' });
    await s.driver.retry(PEER);
    await finish(s, 't2');
    await finish(s, 't3');
    expect(s.driver.status(PEER)).toBeNull();
    expect(new Set(totals(s))).toEqual(new Set(['3']));
    expect(s.fe.engine.send.mock.calls.map((c) => c[0].batch)).toEqual(['1/3', '2/3', '3/3']);
    s.driver.dispose();
  });

  it('a plan over 1 MiB rejects PLAN_TOO_LARGE before the first save', async () => {
    const small = (token: string) => ({ token, name: 'n', size: 1024 });
    // 5000 tokens of 150 two-byte characters: 750 000 UTF-16 units, 1.5 MB as UTF-8.
    const s = setup();
    const big = Array.from({ length: 5000 }, (_, i) => small(`${i}`.padStart(4, '0') + 'é'.repeat(150)));
    expect(JSON.stringify(big.map((r) => r.token)).length).toBeLessThan(PLAN_MAX_BYTES);
    await expect(s.driver.start(PEER, big)).rejects.toThrow(/^PLAN_TOO_LARGE$/);
    expect(s.fe.engine.saveSendPlan).not.toHaveBeenCalled();
    expect(s.media.materialize).not.toHaveBeenCalled();
    expect(s.driver.status(PEER)).toBeNull();
    // 5000 Android photo-picker URIs of about 81 characters fit.
    const t = setup();
    const uris = Array.from({ length: 5000 }, (_, i) =>
      small(`content://media/picker/0/com.android.providers.media.photopicker/media/${1000000 + i}`),
    );
    await expect(t.driver.start(PEER, uris)).resolves.toEqual({ share: SHARE });
    t.driver.dispose();
  });

  it('stop during the split save sends nothing', async () => {
    const s = setup();
    s.media.freeBytes
      .mockResolvedValueOnce(100 * GIB)
      .mockResolvedValueOnce(100 * GIB)
      .mockResolvedValueOnce(GIB);
    const gate = deferred<void>();
    const save = s.fe.engine.saveSendPlan.getMockImplementation()!;
    s.fe.engine.saveSendPlan.mockImplementation(async (p, sh, json) => {
      if (JSON.parse(json).batches.length === 3) await gate.promise;
      return save(p, sh, json);
    });
    const started = s.driver.start(PEER, [ref('a', 1), ref('b', 1), ref('c', 1), ref('d', 3)]);
    await flush();
    const stopped = s.driver.stop(PEER);
    gate.resolve();
    await started;
    await stopped;
    expect(s.fe.engine.send).not.toHaveBeenCalled();
    expect(s.media.discard.mock.calls.map((c) => c[0]).sort()).toEqual(['/cache/a', '/cache/b']);
    expect(s.fe.plans.size).toBe(0);
    s.driver.dispose();
  });

  it('a hung listTransfers does not block stop', async () => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    s.fe.engine.listTransfers.mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(15_000);
    let done = false;
    const stopped = s.driver.stop(PEER).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(done).toBe(true);
    await stopped;
    expect(s.fe.engine.cancel).toHaveBeenCalledWith('t1');
    expect(s.fe.plans.size).toBe(0);
    s.driver.dispose();
  });

  it('a hung listTransfers is no information: the batch is not sent again', async () => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    s.fe.engine.listTransfers.mockImplementationOnce(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(15_000 + 30_000);
    await flush();
    expect(s.fe.engine.send).toHaveBeenCalledTimes(1);
    expect(s.driver.status(PEER)).toMatchObject({ batch: 1, paused: false });
    s.driver.dispose();
  });

  it('the poll does not queue a second check while one is pending', async () => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    const gate = deferred<Awaited<ReturnType<typeof s.fe.engine.listTransfers>>>();
    s.fe.engine.listTransfers.mockClear();
    s.fe.engine.listTransfers.mockImplementationOnce(() => gate.promise);
    // The tick at 15 s starts a check. The tick at 30 s finds it pending.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(s.fe.engine.listTransfers).toHaveBeenCalledTimes(1);
    gate.resolve([...s.fe.rows.values()]);
    await flush();
    expect(s.fe.engine.listTransfers).toHaveBeenCalledTimes(1);
    s.driver.dispose();
  });

  it('a done event clears a pause and advances', async () => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    s.fe.setState('t1', 'failed');
    s.driver.onEvent({ type: 'transfer.failed', transferId: 't1', error: 'x' });
    await flush();
    expect(s.driver.status(PEER)).toMatchObject({ paused: true, error: 'FAILED' });
    // The user taps Retry on the thread row. The transfer ends done.
    await finish(s, 't1');
    expect(s.driver.status(PEER)).toMatchObject({ batch: 2, paused: false });
    expect(s.fe.engine.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(s.fe.plans.get(`${PEER}|${SHARE}`)!).paused).toBeNull();
    s.driver.dispose();
  });

  it('retry falls back to attempt + 1 when engine.retry rejects', async () => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    s.fe.setState('t1', 'failed');
    s.driver.onEvent({ type: 'transfer.failed', transferId: 't1', error: 'x' });
    await flush();
    s.fe.engine.retry.mockRejectedValueOnce(new Error('staged file gone'));
    await s.driver.retry(PEER);
    expect(s.fe.engine.retry).toHaveBeenCalledWith('t1');
    expect(s.fe.engine.send).toHaveBeenCalledTimes(2);
    expect(s.fe.engine.send.mock.calls[1][0]).toMatchObject({ batch: '1/2', attempt: 1, files: ['/cache/a'] });
    expect(s.driver.status(PEER)).toMatchObject({ batch: 1, paused: false });
    s.driver.dispose();
  });
});

describe('the batch driver and a full disk while the engine stages (D2)', () => {
  it('a NO_SPACE send error pauses NO_SPACE with a size, and Retry sends the same batch with the same attempt', async () => {
    // The engine cannot stage the copy of batch 1.
    const t = setup();
    t.fe.engine.send.mockRejectedValueOnce(new Error('transfer: NO_SPACE: the staged copy does not fit'));
    await t.driver.start(PEER, twoBatches);
    await flush();
    const st = t.driver.status(PEER);
    expect(st).toMatchObject({ paused: true, error: 'NO_SPACE', batch: 1 });
    expect(st?.neededBytes).toBeGreaterThan(0);
    // The copies of the batch are gone.
    expect(t.media.discard).toHaveBeenCalledWith('/cache/a');
    await t.driver.retry(PEER);
    expect(t.fe.engine.send).toHaveBeenCalledTimes(2);
    expect(t.fe.engine.send.mock.calls[1][0]).toMatchObject({ batch: '1/2', attempt: 0 });
    expect(t.driver.status(PEER)).toMatchObject({ paused: false, batch: 1 });
    t.driver.dispose();
  });

  it('another send error still pauses FAILED', async () => {
    const t = setup();
    t.fe.engine.send.mockRejectedValueOnce(new Error('io: permission denied'));
    await t.driver.start(PEER, twoBatches);
    await flush();
    expect(t.driver.status(PEER)).toMatchObject({ paused: true, error: 'FAILED' });
    t.driver.dispose();
  });
});

describe('the batch driver and a peer that is offline for a long time (D5)', () => {
  const offline = (s: ReturnType<typeof setup>) =>
    s.fe.engine.devices.mockResolvedValue([
      { deviceId: PEER, name: 'p', addr: '', paired: true, online: false, presence: 'offline' },
    ]);
  const online = (s: ReturnType<typeof setup>) =>
    s.fe.engine.devices.mockResolvedValue([
      { deviceId: PEER, name: 'p', addr: '', paired: true, online: true, presence: 'online' },
    ]);

  it('a batch that the outbox gave up while the peer is offline waits and does not pause', async () => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    offline(s);
    s.fe.setState('t1', 'failed');
    s.driver.onEvent({ type: 'transfer.failed', transferId: 't1', error: 'gave up after 100 attempts' });
    await flush();
    expect(s.driver.status(PEER)).toMatchObject({ paused: false, batch: 1, transferId: 't1' });
    // The poll goes on. No retry while the peer is offline.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.fe.engine.retry).not.toHaveBeenCalled();
    expect(s.driver.status(PEER)).toMatchObject({ paused: false });
    s.driver.dispose();
  });

  it('when the peer comes online the poll re-arms the failed row once and the plan goes on', async () => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    offline(s);
    s.fe.setState('t1', 'failed');
    s.driver.onEvent({ type: 'transfer.failed', transferId: 't1', error: 'x' });
    await flush();
    online(s);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(s.fe.engine.retry).toHaveBeenCalledWith('t1');
    expect(s.fe.engine.retry).toHaveBeenCalledTimes(1);
    expect(s.driver.status(PEER)).toMatchObject({ paused: false, batch: 1 });
    await finish(s, 't1');
    expect(s.fe.engine.send).toHaveBeenCalledTimes(2);
    s.driver.dispose();
  });

  it('a device.state online event re-arms the row without a wait for the poll', async () => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    offline(s);
    s.fe.setState('t1', 'failed');
    s.driver.onEvent({ type: 'transfer.failed', transferId: 't1', error: 'x' });
    await flush();
    online(s);
    s.driver.onEvent({ type: 'device.state', deviceId: PEER, state: 'online' });
    await flush();
    expect(s.fe.engine.retry).toHaveBeenCalledWith('t1');
    s.driver.dispose();
  });

  it('a second failure while the peer is online after the re-arm pauses FAILED', async () => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    offline(s);
    s.fe.setState('t1', 'failed');
    s.driver.onEvent({ type: 'transfer.failed', transferId: 't1', error: 'x' });
    await flush();
    online(s);
    s.driver.onEvent({ type: 'device.state', deviceId: PEER, state: 'online' });
    await flush();
    s.fe.setState('t1', 'failed');
    s.driver.onEvent({ type: 'transfer.failed', transferId: 't1', error: 'x' });
    await flush();
    expect(s.fe.engine.retry).toHaveBeenCalledTimes(1);
    expect(s.driver.status(PEER)).toMatchObject({ paused: true, error: 'FAILED' });
    s.driver.dispose();
  });

  it('a failure while the peer is online pauses FAILED, as before', async () => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    s.fe.setState('t1', 'failed');
    s.driver.onEvent({ type: 'transfer.failed', transferId: 't1', error: 'x' });
    await flush();
    expect(s.fe.engine.retry).not.toHaveBeenCalled();
    expect(s.driver.status(PEER)).toMatchObject({ paused: true, error: 'FAILED' });
    s.driver.dispose();
  });

  it('a devices() failure keeps the batch waiting and does not pause', async () => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    s.fe.engine.devices.mockRejectedValue(new Error('down'));
    s.fe.setState('t1', 'failed');
    s.driver.onEvent({ type: 'transfer.failed', transferId: 't1', error: 'x' });
    await flush();
    expect(s.driver.status(PEER)).toMatchObject({ paused: false });
    s.driver.dispose();
  });
});

describe('the batch driver retry fallback (D3)', () => {
  it('cancels the old failed row so the engine removes its staged batch, then sends again', async () => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    s.fe.setState('t1', 'failed');
    s.driver.onEvent({ type: 'transfer.failed', transferId: 't1', error: 'x' });
    await flush();
    s.fe.engine.retry.mockRejectedValueOnce(new Error('db busy'));
    await s.driver.retry(PEER);
    expect(s.fe.engine.cancel).toHaveBeenCalledWith('t1');
    const cancelAt = s.fe.engine.cancel.mock.invocationCallOrder[0];
    const sendAt = s.fe.engine.send.mock.invocationCallOrder[1];
    expect(cancelAt).toBeLessThan(sendAt);
    expect(s.fe.engine.send.mock.calls[1][0]).toMatchObject({ batch: '1/2', attempt: 1 });
    s.driver.dispose();
  });

  it('a cancel that rejects does not stop the new send', async () => {
    const s = setup();
    await s.driver.start(PEER, twoBatches);
    s.fe.setState('t1', 'failed');
    s.driver.onEvent({ type: 'transfer.failed', transferId: 't1', error: 'x' });
    await flush();
    s.fe.engine.retry.mockRejectedValueOnce(new Error('db busy'));
    s.fe.engine.cancel.mockRejectedValueOnce(new Error('gone'));
    await s.driver.retry(PEER);
    expect(s.fe.engine.send).toHaveBeenCalledTimes(2);
    s.driver.dispose();
  });
});

describe('the batch driver after the second review', () => {
  it('a failed marker save sends nothing, discards the copies and pauses FAILED', async () => {
    const s = setup();
    const save = s.fe.engine.saveSendPlan.getMockImplementation()!;
    s.fe.engine.saveSendPlan.mockImplementation(async (p, sh, json) => {
      if (JSON.parse(json).sending !== null) throw new Error('disk');
      return save(p, sh, json);
    });
    await s.driver.start(PEER, [ref('a', 1), ref('b', 1)]);
    expect(s.fe.engine.send).not.toHaveBeenCalled();
    expect(s.media.discard.mock.calls.map((c) => c[0]).sort()).toEqual(['/cache/a', '/cache/b']);
    expect(s.driver.status(PEER)).toMatchObject({ paused: true, error: 'FAILED' });
    // The save works again. Retry sends the same batch with the same attempt.
    s.fe.engine.saveSendPlan.mockImplementation(save);
    await s.driver.retry(PEER);
    expect(s.fe.engine.send).toHaveBeenCalledTimes(1);
    expect(s.fe.engine.send.mock.calls[0][0]).toMatchObject({ batch: '1/1', attempt: 0 });
    s.driver.dispose();
  });

  it('a send that rejects keeps sending set and the retry sends the same batch once', async () => {
    const s = setup();
    // The engine makes the row and then the send rejects.
    const send = s.fe.engine.send.getMockImplementation()!;
    s.fe.engine.send.mockImplementationOnce(async (req) => {
      await send(req);
      throw new Error('late');
    });
    await s.driver.start(PEER, twoBatches);
    expect(s.driver.status(PEER)).toMatchObject({ paused: true, error: 'FAILED' });
    expect(JSON.parse(s.fe.plans.get(`${PEER}|${SHARE}`)!).sending).toBe(0);
    await s.driver.retry(PEER);
    expect(s.fe.engine.send.mock.calls[1][0]).toMatchObject({ batch: '1/2', attempt: 0 });
    expect(s.fe.rows.size).toBe(1);
    await finish(s, 't1');
    await finish(s, 't2');
    expect(s.driver.status(PEER)).toBeNull();
    // Each file path is in exactly one transfer.
    const files = s.fe.sent().flatMap((r) => r.req.files ?? []);
    expect(files.sort()).toEqual(['/cache/a', '/cache/b']);
    s.driver.dispose();
  });

  it('a stop during the first plan save leaves no plan and sends nothing', async () => {
    const s = setup();
    const gate = deferred<void>();
    const save = s.fe.engine.saveSendPlan.getMockImplementation()!;
    s.fe.engine.saveSendPlan.mockImplementationOnce(async (p, sh, json) => {
      await gate.promise;
      return save(p, sh, json);
    });
    const started = s.driver.start(PEER, twoBatches);
    await flush();
    expect(s.driver.status(PEER)).not.toBeNull();
    const stopped = s.driver.stop(PEER);
    await flush();
    gate.resolve();
    await expect(started).resolves.toEqual({ share: SHARE });
    await stopped;
    expect(s.fe.plans.size).toBe(0);
    expect(s.fe.engine.send).not.toHaveBeenCalled();
    expect(s.media.materialize).not.toHaveBeenCalled();
    expect(s.media.release).toHaveBeenCalledTimes(1);
    expect(s.media.release).toHaveBeenCalledWith(['a', 'b']);
    expect(s.driver.status(PEER)).toBeNull();
    // A new start for the peer works.
    await expect(s.driver.start(PEER, twoBatches)).resolves.toEqual({ share: SHARE });
    expect(s.fe.engine.send).toHaveBeenCalledTimes(1);
    s.driver.dispose();
  });
});

// D6: the driver limit and the engine limit must be equal. A smaller engine
// limit makes a plan that the driver accepts fail at the first save.
describe('the plan size limit', () => {
  it('PLAN_MAX_BYTES equals SEND_PLAN_MAX_BYTES in crates/daak-core/src/engine.rs', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '../../../crates/daak-core/src/engine.rs'), 'utf8');
    const m = /const SEND_PLAN_MAX_BYTES: usize = ([\d_ *]+);/.exec(src);
    expect(m).not.toBeNull();
    const terms = (m?.[1] ?? '').split('*').map((t) => Number(t.trim().replace(/_/g, '')));
    expect(terms.every((t) => Number.isInteger(t) && t > 0)).toBe(true);
    expect(terms.reduce((a, b) => a * b, 1)).toBe(PLAN_MAX_BYTES);
  });
});
