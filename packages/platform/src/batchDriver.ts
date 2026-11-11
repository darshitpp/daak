// Send a large photo and video selection in batches. The driver sends one
// batch as one transfer. It copies the items of one batch into the send cache,
// sends them, and deletes the copies when `send()` resolves. Then it waits for
// the end of that transfer before it starts the next batch. So the disk holds
// at most one batch of copies.
//
// The driver saves the plan in the engine after each step, so a restart can
// continue. The saved plan holds tokens and sizes. It holds no name and no path.
//
// The driver does not trust an event. An event is a trigger: the driver reads
// the state of the transfer with `listTransfers`. A poll every 15 s does the
// same read, because a cancel and a revoke send no event.
import type { DaakEngine, DaakEvent } from '@daak/core';
import { DEFAULT_ITEM_BYTES, GIB, planBatches, type Batch } from './planBatches';
import type { MediaRef } from './share';

type PauseError = 'NO_SPACE' | 'PLAN_LOST' | 'FAILED' | 'CANCELED';

export type PlanStatus = {
  share: string;
  batch: number;
  of: number;
  paused: boolean;
  error?: PauseError;
  neededBytes?: number;
  /** The number of items in the batches after the current batch. */
  remaining: number;
  bytesDone: number;
  bytesTotal: number;
};

export type BatchDriverDeps = {
  engine: Pick<
    DaakEngine,
    'send' | 'listTransfers' | 'retry' | 'cancel' | 'devices' | 'saveSendPlan' | 'listSendPlans' | 'deleteSendPlan'
  >;
  media: {
    materialize(token: string): Promise<string>;
    discard(path: string): Promise<void>;
    freeBytes(): Promise<number>;
    /** Give back the access to the sources when a plan ends. */
    release?(tokens: string[]): Promise<void>;
  };
  platform: 'android' | 'ios';
  /** 32 lower case hex characters. */
  randomShare(): string;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  onChange?(peerId: string): void;
  /** Do not give a name, a token, a path, or a share to this function. */
  log?(msg: string): void;
};

export type BatchDriver = {
  start(peerId: string, refs: MediaRef[]): Promise<{ share: string }>;
  onEvent(event: DaakEvent): void;
  retry(peerId: string): Promise<void>;
  stop(peerId: string): Promise<void>;
  status(peerId: string): PlanStatus | null;
  resume(peers: string[]): Promise<void>;
  dispose(): void;
};

type SavedPlan = {
  v: 1;
  share: string;
  peerId: string;
  platform: 'android' | 'ios';
  batches: Batch[];
  /** The 1-based index of the batch to send or in flight. */
  cursor: number;
  inflight: { transferId: string; attempt: number } | null;
  paused: null | { error: PauseError; neededBytes?: number };
  /** The attempt counter of the current batch. */
  attempt: number;
};

type Entry = {
  /** Null while `start` computes the plan. */
  plan: SavedPlan | null;
  /** The steps of one plan run in this order. */
  chain: Promise<void>;
  stopped: boolean;
};

export const POLL_MS = 15_000;
const SHARE_RE = /^[0-9a-f]{32}$/;
const PAUSE_ERRORS: readonly string[] = ['NO_SPACE', 'PLAN_LOST', 'FAILED', 'CANCELED'];

const isCount = (n: unknown, min: number): n is number => Number.isInteger(n) && (n as number) >= min;

/** The saved plan, or null when the text is not a valid version 1 plan. */
function parsePlan(text: string, peerId: string, share: string): SavedPlan | null {
  let p: unknown;
  try {
    p = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof p !== 'object' || p === null) return null;
  const o = p as Record<string, unknown>;
  if (o.v !== 1 || o.share !== share || !SHARE_RE.test(share) || o.peerId !== peerId) return null;
  if (o.platform !== 'android' && o.platform !== 'ios') return null;
  if (!Array.isArray(o.batches) || o.batches.length === 0) return null;
  const of = o.batches.length;
  const batchOk = (b: unknown, i: number) => {
    if (typeof b !== 'object' || b === null) return false;
    const x = b as Record<string, unknown>;
    return (
      x.index === i + 1 &&
      x.of === of &&
      Array.isArray(x.tokens) &&
      x.tokens.length > 0 &&
      x.tokens.every((t) => typeof t === 'string') &&
      typeof x.bytes === 'number' &&
      Number.isFinite(x.bytes) &&
      x.bytes >= 0
    );
  };
  if (!o.batches.every(batchOk)) return null;
  if (!isCount(o.cursor, 1) || o.cursor > of || !isCount(o.attempt, 0)) return null;
  if (o.inflight !== null) {
    const f = o.inflight as Record<string, unknown> | undefined;
    if (typeof f !== 'object' || typeof f.transferId !== 'string' || !isCount(f.attempt, 0)) return null;
  }
  if (o.paused !== null) {
    const q = o.paused as Record<string, unknown> | undefined;
    if (typeof q !== 'object' || typeof q.error !== 'string' || !PAUSE_ERRORS.includes(q.error)) return null;
    if (q.neededBytes !== undefined && !isCount(q.neededBytes, 0)) return null;
  }
  return p as SavedPlan;
}

const allTokens = (p: SavedPlan) => p.batches.flatMap((b) => b.tokens);

export function createBatchDriver(deps: BatchDriverDeps): BatchDriver {
  const { engine, media } = deps;
  const entries = new Map<string, Entry>();
  let poll: unknown = null;
  let disposed = false;
  const log = (msg: string) => deps.log?.(msg);
  const changed = (peerId: string) => deps.onChange?.(peerId);

  const waiting = (e: Entry) => e.plan !== null && e.plan.inflight !== null && e.plan.paused === null;

  // The poll runs while at least one plan has a batch in flight.
  function updatePoll() {
    const need = [...entries.values()].some(waiting);
    if (need && poll === null && !disposed) {
      poll = deps.setInterval(() => {
        for (const e of entries.values()) {
          if (!waiting(e)) continue;
          const id = e.plan!.inflight!.transferId;
          void step(e, () => check(e, id));
        }
      }, POLL_MS);
    } else if (!need && poll !== null) {
      deps.clearInterval(poll);
      poll = null;
    }
  }

  // Run one step of a plan after the steps before it. A step never rejects the
  // chain, so a later step always runs.
  function step(e: Entry, fn: () => Promise<void>): Promise<void> {
    const next = e.chain.then(async () => {
      try {
        if (!e.stopped) await fn();
      } catch {
        log('batch driver: a step failed');
      } finally {
        updatePoll();
      }
    });
    e.chain = next;
    return next;
  }

  async function save(p: SavedPlan): Promise<void> {
    try {
      await engine.saveSendPlan(p.peerId, p.share, JSON.stringify(p));
    } catch {
      // A plan that is not saved sends the batch again after a restart. The
      // derived payload id makes that send return the existing row.
      log('batch driver: the plan save failed');
    }
  }

  async function discardAll(paths: string[]): Promise<void> {
    for (const path of paths.splice(0)) {
      try {
        await media.discard(path);
      } catch {
        // The startup sweep removes the copy.
      }
    }
  }

  async function release(p: SavedPlan): Promise<void> {
    try {
      await media.release?.(allTokens(p));
    } catch {
      log('batch driver: the release failed');
    }
  }

  async function pause(p: SavedPlan, error: PauseError, neededBytes?: number): Promise<void> {
    p.paused = neededBytes === undefined ? { error } : { error, neededBytes };
    log(`batch driver: paused ${error}`);
    await save(p);
    changed(p.peerId);
  }

  // Close the current batch before item `at`. The rest of its tokens become a
  // new batch right after it. The bytes split by the count of items, because
  // the plan keeps no size for one item.
  function split(p: SavedPlan, at: number): void {
    const cur = p.batches[p.cursor - 1];
    const rest = cur.tokens.slice(at);
    const restBytes = Math.round((cur.bytes * rest.length) / cur.tokens.length);
    const head: Batch = { ...cur, tokens: cur.tokens.slice(0, at), bytes: cur.bytes - restBytes };
    const tail: Batch = { ...cur, tokens: rest, bytes: restBytes };
    const all = [...p.batches.slice(0, p.cursor - 1), head, tail, ...p.batches.slice(p.cursor)];
    p.batches = all.map((b, i) => ({ ...b, index: i + 1, of: all.length }));
  }

  // Copy the items of the current batch, send them as one transfer, and delete
  // the copies. Every copy is deleted on every path.
  async function runBatch(e: Entry): Promise<void> {
    const p = e.plan!;
    const b = p.batches[p.cursor - 1];
    const attempt = p.attempt;
    const paths: string[] = [];
    let at = b.tokens.length;
    for (let i = 0; i < b.tokens.length; i++) {
      if (i > 0 && (await media.freeBytes()) < GIB + DEFAULT_ITEM_BYTES) {
        at = i;
        break;
      }
      try {
        paths.push(await media.materialize(b.tokens[i]));
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.startsWith('NO_SPACE') && i > 0) {
          at = i;
          break;
        }
        await discardAll(paths);
        if (msg.startsWith('NO_SPACE')) {
          const n = Number(msg.slice('NO_SPACE:'.length));
          return pause(p, 'NO_SPACE', Number.isSafeInteger(n) && n > 0 ? n : undefined);
        }
        return pause(p, msg === 'E_SOURCE_GONE' ? 'PLAN_LOST' : 'FAILED');
      }
      if (e.stopped) return discardAll(paths);
    }
    if (at < b.tokens.length) {
      split(p, at);
      await save(p);
      changed(p.peerId);
    }
    const cur = p.batches[p.cursor - 1];
    let transferId: string;
    try {
      ({ transferId } = await engine.send({
        peerDeviceId: p.peerId,
        files: [...paths],
        share: p.share,
        batch: `${cur.index}/${cur.of}`,
        attempt,
      }));
    } catch {
      await discardAll(paths);
      return pause(p, 'FAILED');
    }
    // The engine staged the files. The copies are not needed now.
    await discardAll(paths);
    p.inflight = { transferId, attempt };
    await save(p);
    changed(p.peerId);
    // A repeated send can return a row that already ended.
    if (!e.stopped) await check(e, transferId);
  }

  async function finish(e: Entry): Promise<void> {
    const p = e.plan!;
    try {
      await engine.deleteSendPlan(p.peerId, p.share);
    } catch {
      log('batch driver: the plan delete failed');
    }
    await release(p);
    if (entries.get(p.peerId) === e) entries.delete(p.peerId);
    changed(p.peerId);
  }

  async function stateOf(p: SavedPlan, transferId: string): Promise<string | null> {
    const rows = await engine.listTransfers({ peerDeviceId: p.peerId });
    return rows.find((r) => r.transferId === transferId)?.state ?? null;
  }

  // Read the state of the in-flight transfer and act on it. `done` advances.
  // `failed` and `canceled` pause. A row that is not found runs the batch
  // again with the same attempt: the derived id makes this send safe. Any
  // other state is a wait.
  async function check(e: Entry, transferId: string): Promise<void> {
    const p = e.plan!;
    if (p.paused !== null || p.inflight?.transferId !== transferId) return;
    const state = await stateOf(p, transferId);
    if (state === 'done') {
      p.inflight = null;
      p.attempt = 0;
      p.cursor += 1;
      if (p.cursor > p.batches.length) return finish(e);
      await save(p);
      changed(p.peerId);
      return runBatch(e);
    }
    if (state === 'failed') return pause(p, 'FAILED');
    if (state === 'canceled') return pause(p, 'CANCELED');
    if (state === null) {
      p.inflight = null;
      return runBatch(e);
    }
  }

  async function start(peerId: string, refs: MediaRef[]): Promise<{ share: string }> {
    if (entries.has(peerId)) throw new Error('PLAN_BUSY');
    const e: Entry = { plan: null, chain: Promise.resolve(), stopped: false };
    entries.set(peerId, e);
    const share = deps.randomShare();
    try {
      if ((await engine.listSendPlans(peerId)).length > 0) throw new Error('PLAN_BUSY');
      const free = await media.freeBytes();
      const batches = planBatches(
        refs.map((r) => ({ token: r.token, size: r.size })),
        { free, platform: deps.platform },
      );
      e.plan = {
        v: 1,
        share,
        peerId,
        platform: deps.platform,
        batches,
        cursor: 1,
        inflight: null,
        paused: null,
        attempt: 0,
      };
      await engine.saveSendPlan(peerId, share, JSON.stringify(e.plan));
    } catch (err) {
      entries.delete(peerId);
      throw err;
    }
    changed(peerId);
    await step(e, () => runBatch(e));
    return { share };
  }

  function onEvent(event: DaakEvent): void {
    if (event.type !== 'transfer.done' && event.type !== 'transfer.failed') return;
    for (const e of entries.values()) {
      if (e.plan?.inflight?.transferId === event.transferId) {
        void step(e, () => check(e, event.transferId));
      }
    }
  }

  async function retry(peerId: string): Promise<void> {
    const e = entries.get(peerId);
    if (!e?.plan) return;
    await step(e, async () => {
      const p = e.plan!;
      if (p.paused === null) return;
      const id = p.inflight?.transferId;
      const state = id === undefined ? null : await stateOf(p, id);
      p.paused = null;
      if (id !== undefined && state === 'failed') {
        // The row still holds its staged file.
        await engine.retry(id);
        await save(p);
        changed(peerId);
        return;
      }
      if (id !== undefined && state !== null && state !== 'canceled') {
        // The row is alive again. Read it as a poll does.
        await save(p);
        changed(peerId);
        return check(e, id);
      }
      // No row to retry: run the same batch with a new derived id.
      p.inflight = null;
      p.attempt += 1;
      return runBatch(e);
    });
  }

  async function stop(peerId: string): Promise<void> {
    const e = entries.get(peerId);
    if (!e?.plan || e.stopped) return;
    e.stopped = true;
    const p = e.plan;
    // This step runs also when the plan is stopped.
    const next = e.chain.then(async () => {
      // The last batch can end before this step runs.
      if (entries.get(peerId) !== e) return;
      if (p.inflight !== null) {
        try {
          await engine.cancel(p.inflight.transferId);
        } catch {
          // The row is already at an end.
        }
      }
      await finish(e);
      updatePoll();
    });
    e.chain = next.catch(() => undefined);
    await e.chain;
  }

  function status(peerId: string): PlanStatus | null {
    const p = entries.get(peerId)?.plan;
    if (!p) return null;
    const cur = p.batches[p.cursor - 1];
    const sum = (bs: Batch[]) => bs.reduce((n, b) => n + b.bytes, 0);
    const s: PlanStatus = {
      share: p.share,
      batch: cur.index,
      of: cur.of,
      paused: p.paused !== null,
      remaining: p.batches.slice(p.cursor).reduce((n, b) => n + b.tokens.length, 0),
      bytesDone: sum(p.batches.slice(0, p.cursor - 1)),
      bytesTotal: sum(p.batches),
    };
    if (p.paused) {
      s.error = p.paused.error;
      if (p.paused.neededBytes !== undefined) s.neededBytes = p.paused.neededBytes;
    }
    return s;
  }

  async function resumePeer(peerId: string, paired: boolean): Promise<void> {
    if (entries.has(peerId)) return;
    const listed = await engine.listSendPlans(peerId);
    const valid: SavedPlan[] = [];
    for (const { share, plan } of listed) {
      const p = parsePlan(plan, peerId, share);
      if (p) valid.push(p);
      else await engine.deleteSendPlan(peerId, share);
    }
    if (valid.length === 0) return;
    if (!paired) {
      for (const p of valid) {
        await engine.deleteSendPlan(peerId, p.share);
        await release(p);
      }
      return;
    }
    valid.sort((a, b) => a.cursor - b.cursor);
    const [keep, ...extra] = valid;
    const kept = new Set(allTokens(keep));
    for (const p of extra) {
      await engine.deleteSendPlan(peerId, p.share);
      // Keep the access to a source that the kept plan also sends.
      const own = allTokens(p).filter((t) => !kept.has(t));
      if (own.length > 0) {
        try {
          await media.release?.(own);
        } catch {
          log('batch driver: the release failed');
        }
      }
    }
    if (entries.has(peerId)) return;
    const e: Entry = { plan: keep, chain: Promise.resolve(), stopped: false };
    entries.set(peerId, e);
    changed(peerId);
    if (keep.paused !== null) return;
    await step(e, () => (keep.inflight === null ? runBatch(e) : check(e, keep.inflight.transferId)));
  }

  async function resume(peers: string[]): Promise<void> {
    let devices: Awaited<ReturnType<typeof engine.devices>>;
    try {
      devices = await engine.devices();
    } catch {
      log('batch driver: the device list failed');
      return;
    }
    const paired = new Set(devices.filter((d) => d.paired === true).map((d) => d.deviceId));
    for (const peerId of peers) {
      try {
        await resumePeer(peerId, paired.has(peerId));
      } catch {
        log('batch driver: a resume failed');
      }
    }
  }

  function dispose(): void {
    disposed = true;
    if (poll !== null) deps.clearInterval(poll);
    poll = null;
  }

  return { start, onEvent, retry, stop, status, resume, dispose };
}
