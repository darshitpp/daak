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
import { DEFAULT_ITEM_BYTES, GIB, MAX_BATCHES, planBatches, type Batch } from './planBatches';
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
  /** The time limit of a `listTransfers` read. The globals are the default. */
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
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
  /**
   * The attempt of a `send` that started and has no saved result. A plan with
   * `sending` and no `inflight` sends the same batch with this attempt again,
   * with no split. The derived id then returns the row of the first send.
   * Optional in the saved text: an older plan parses as null.
   */
  sending: number | null;
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
  /** True while a poll check of this plan is queued or runs. */
  polling: boolean;
};

export const POLL_MS = 15_000;
/** The time limit of one `listTransfers` read. */
export const LIST_TIMEOUT_MS = 30_000;
/** The largest saved plan. The engine refuses a larger one (`SEND_PLAN_MAX_BYTES`). */
export const PLAN_MAX_BYTES = 1024 * 1024;
/**
 * Room for the fields that a later save adds to the plan of `start`: one more
 * batch from a split, a longer `of` in each batch, `inflight`, and `sending`.
 */
const PLAN_GROWTH_BYTES = 8 * 1024;
/** The receiver refuses a batch tag with a total over 1000 (`parse_batch_tag`). */
const SHARE_RE = /^[0-9a-f]{32}$/;
const PAUSE_ERRORS: readonly string[] = ['NO_SPACE', 'PLAN_LOST', 'FAILED', 'CANCELED'];

const isCount = (n: unknown, min: number): n is number => Number.isInteger(n) && (n as number) >= min;

/** The UTF-8 length of a text. */
function utf8Bytes(text: string): number {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

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
  if (o.sending !== undefined && o.sending !== null && !isCount(o.sending, 0)) return null;
  if (o.paused !== null) {
    const q = o.paused as Record<string, unknown> | undefined;
    if (typeof q !== 'object' || typeof q.error !== 'string' || !PAUSE_ERRORS.includes(q.error)) return null;
    if (q.neededBytes !== undefined && !isCount(q.neededBytes, 0)) return null;
  }
  return { ...(p as SavedPlan), sending: (o.sending as number | null | undefined) ?? null };
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
          // A check that is queued or runs is enough. Do not queue more.
          if (!waiting(e) || e.polling) continue;
          e.polling = true;
          const id = e.plan!.inflight!.transferId;
          void step(e, () => check(e, id)).then(() => {
            e.polling = false;
          });
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

  // True when the engine saved the plan. A failed save is safe only after the
  // `sending` marker is saved: a resume then sends the same batch with the same
  // attempt, and the derived payload id returns the existing row. The marker
  // save itself must succeed before `send`, so the caller checks the result.
  async function save(p: SavedPlan): Promise<boolean> {
    try {
      await engine.saveSendPlan(p.peerId, p.share, JSON.stringify(p));
      return true;
    } catch {
      log('batch driver: the plan save failed');
      return false;
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
    // A saved `sending` with no `inflight`: an earlier send has no saved
    // result. Send the same items with the same attempt.
    const resend = p.sending !== null;
    if (resend) p.attempt = p.sending!;
    const attempt = p.attempt;
    const b = p.batches[p.cursor - 1];
    // A split changes the total m of every batch. The receiver keeps the first
    // m that it gets. So only the first batch can split, before any send.
    const canSplit = !resend && p.cursor === 1 && attempt === 0 && p.batches.length < MAX_BATCHES;
    const paths: string[] = [];
    let transferId: string;
    try {
      let at = b.tokens.length;
      for (let i = 0; i < b.tokens.length; i++) {
        if (i > 0 && (await media.freeBytes()) < GIB + DEFAULT_ITEM_BYTES) {
          if (!canSplit) {
            await discardAll(paths);
            return await pause(p, 'NO_SPACE', b.bytes + GIB);
          }
          at = i;
          break;
        }
        try {
          paths.push(await media.materialize(b.tokens[i]));
        } catch (err) {
          const msg = err instanceof Error ? err.message : '';
          if (msg.startsWith('NO_SPACE') && i > 0 && canSplit) {
            at = i;
            break;
          }
          await discardAll(paths);
          if (msg.startsWith('NO_SPACE')) {
            const n = Number(msg.slice('NO_SPACE:'.length));
            return await pause(p, 'NO_SPACE', Number.isSafeInteger(n) && n > 0 ? n : undefined);
          }
          return await pause(p, msg === 'E_SOURCE_GONE' ? 'PLAN_LOST' : 'FAILED');
        }
        if (e.stopped) return await discardAll(paths);
      }
      if (at < b.tokens.length) split(p, at);
      // One save holds the split and the mark of the send. Without this save a
      // resume can split the batch again and send an item twice: do not send.
      // `sending` stays in memory, so a retry uses the same attempt.
      p.sending = attempt;
      if (!(await save(p))) {
        await discardAll(paths);
        return await pause(p, 'FAILED');
      }
      changed(p.peerId);
      if (e.stopped) return await discardAll(paths);
      const cur = p.batches[p.cursor - 1];
      try {
        ({ transferId } = await engine.send({
          peerDeviceId: p.peerId,
          files: [...paths],
          share: p.share,
          batch: `${cur.index}/${cur.of}`,
          attempt,
        }));
      } catch {
        // The engine can make the row and then reject. Keep `sending`: the
        // retry uses the same attempt, so it finds that row or makes it once.
        await discardAll(paths);
        return await pause(p, 'FAILED');
      }
      // The engine staged the files. The copies are not needed now.
      await discardAll(paths);
      p.sending = null;
      p.inflight = { transferId, attempt };
      await save(p);
      changed(p.peerId);
    } catch {
      await discardAll(paths);
      return pause(p, 'FAILED');
    }
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

  // The state of a transfer, null when the row is not found, or undefined when
  // the read failed or took more than LIST_TIMEOUT_MS. Undefined is no
  // information: the caller does nothing.
  async function stateOf(p: SavedPlan, transferId: string): Promise<string | null | undefined> {
    const setT = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clearT = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
    let timer: unknown = null;
    const late = new Promise<undefined>((resolve) => {
      timer = setT(() => resolve(undefined), LIST_TIMEOUT_MS);
    });
    try {
      const rows = await Promise.race([engine.listTransfers({ peerDeviceId: p.peerId }), late]);
      if (rows === undefined) {
        log('batch driver: the transfer list timed out');
        return undefined;
      }
      return rows.find((r) => r.transferId === transferId)?.state ?? null;
    } catch {
      log('batch driver: the transfer list failed');
      return undefined;
    } finally {
      clearT(timer);
    }
  }

  // Read the state of the in-flight transfer and act on it. `done` advances,
  // also from a pause (the user can retry the row in the thread). `failed`
  // and `canceled` pause. A row that is not found runs the batch again with
  // the same attempt: the derived id makes this send safe. Any other state is
  // a wait.
  async function check(e: Entry, transferId: string): Promise<void> {
    const p = e.plan!;
    if (p.inflight?.transferId !== transferId) return;
    const state = await stateOf(p, transferId);
    if (state === undefined) return;
    if (p.paused !== null && state !== 'done') return;
    if (state === 'done') {
      p.paused = null;
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
      p.sending = p.inflight.attempt;
      p.inflight = null;
      return runBatch(e);
    }
  }

  async function start(peerId: string, refs: MediaRef[]): Promise<{ share: string }> {
    if (entries.has(peerId)) throw new Error('PLAN_BUSY');
    // The chain opens when the first save ends. A stop before that waits, then
    // deletes the saved plan. Otherwise the save comes last and leaves the plan.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const e: Entry = { plan: null, chain: gate, stopped: false, polling: false };
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
        sending: null,
        paused: null,
        attempt: 0,
      };
      const text = JSON.stringify(e.plan);
      if (utf8Bytes(text) + PLAN_GROWTH_BYTES > PLAN_MAX_BYTES) throw new Error('PLAN_TOO_LARGE');
      await engine.saveSendPlan(peerId, share, text);
    } catch (err) {
      entries.delete(peerId);
      throw err;
    } finally {
      open();
    }
    changed(peerId);
    // A stop step that waits on the gate runs first. Then this step does not run.
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
      // No information: the plan stays paused. The user can tap Retry again.
      if (state === undefined) return;
      p.paused = null;
      if (id !== undefined && state === 'failed') {
        try {
          // The row still holds its staged file.
          await engine.retry(id);
          await save(p);
          changed(peerId);
          return;
        } catch {
          // The staged file can be gone. Send the batch again below.
          log('batch driver: the engine retry failed');
        }
      } else if (id !== undefined && state !== null && state !== 'canceled') {
        // The row is alive again. Read it as a poll does.
        await save(p);
        changed(peerId);
        return check(e, id);
      }
      p.inflight = null;
      // A send with no saved result keeps its attempt: the derived id finds
      // that row. Otherwise run the same batch with a new derived id.
      if (p.sending === null) p.attempt += 1;
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
    const e: Entry = { plan: keep, chain: Promise.resolve(), stopped: false, polling: false };
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
