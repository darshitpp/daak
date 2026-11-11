// Fakes for the batch driver tests. The fake engine keeps its rows and its
// plans in maps. A send with the same peer, share, batch index k, and attempt
// returns the row that exists, as the derived payload id does in the real
// engine. The batch total m is not part of the key, as in the real engine.
import { vi } from 'vitest';
import type { SendRequest, TransferSummary } from '@daak/core';
import { createBatchDriver, type BatchDriverDeps } from '../src/batchDriver';
import { GIB } from '../src/planBatches';

export const PEER = 'a'.repeat(32);
export const PEER2 = 'b'.repeat(32);
export const SHARE = '0123456789abcdef0123456789abcdef';

export type Row = TransferSummary & { req: SendRequest };

export function fakeEngine() {
  const rows = new Map<string, Row>();
  const plans = new Map<string, string>();
  let n = 0;
  const key = (r: SendRequest) => `${r.peerDeviceId}|${r.share}|${r.batch?.split('/')[0]}|${r.attempt}`;
  const engine = {
    send: vi.fn(async (req: SendRequest) => {
      const found = [...rows.values()].find((r) => key(r.req) === key(req));
      if (found) return { transferId: found.transferId, queued: true };
      const transferId = `t${++n}`;
      rows.set(transferId, {
        transferId,
        peerDeviceId: req.peerDeviceId,
        direction: 'out',
        kind: 'batch',
        state: 'queued',
        bytesDone: 0,
        bytesTotal: 0,
        itemCount: req.files?.length ?? 0,
        updatedAt: 0,
        req,
      });
      return { transferId, queued: true };
    }),
    listTransfers: vi.fn(async (f?: { state?: string; peerDeviceId?: string }) =>
      [...rows.values()].filter((r) => !f?.peerDeviceId || r.peerDeviceId === f.peerDeviceId),
    ),
    retry: vi.fn(async (id: string) => {
      const r = rows.get(id);
      if (r) r.state = 'queued';
    }),
    cancel: vi.fn(async (id: string) => {
      const r = rows.get(id);
      if (r) r.state = 'canceled';
    }),
    devices: vi.fn(async () => [
      { deviceId: PEER, name: 'p', addr: '', paired: true },
      { deviceId: PEER2, name: 'q', addr: '', paired: true },
    ]),
    saveSendPlan: vi.fn(async (peer: string, share: string, json: string) => {
      plans.set(`${peer}|${share}`, json);
    }),
    listSendPlans: vi.fn(async (peer: string) =>
      [...plans.entries()]
        .filter(([k]) => k.startsWith(`${peer}|`))
        .map(([k, plan]) => ({ share: k.split('|')[1], plan })),
    ),
    deleteSendPlan: vi.fn(async (peer: string, share: string) => {
      plans.delete(`${peer}|${share}`);
    }),
  };
  return {
    engine,
    rows,
    plans,
    setState(id: string, state: string) {
      const r = rows.get(id);
      if (!r) throw new Error(`no row ${id}`);
      r.state = state;
    },
    /** The rows in send order. */
    sent: () => [...rows.values()],
  };
}

export function fakeMedia() {
  return {
    materialize: vi.fn(async (token: string) => `/cache/${token}`),
    discard: vi.fn(async (_path: string) => {}),
    freeBytes: vi.fn(async () => 100 * GIB),
    release: vi.fn(async (_tokens: string[]) => {}),
  };
}

export function setup(over: Partial<BatchDriverDeps> = {}) {
  const fe = fakeEngine();
  const media = fakeMedia();
  const onChange = vi.fn();
  const log = vi.fn();
  const deps: BatchDriverDeps = {
    engine: fe.engine,
    media,
    platform: 'ios',
    randomShare: () => SHARE,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    onChange,
    log,
    ...over,
  };
  const driver = createBatchDriver(deps);
  return { fe, media, onChange, log, driver, deps };
}

/** Let every pending promise step run. The driver chains many awaits. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

/** A ref of `gib` GiB. With 100 GiB free on iOS a batch holds at most 4 GiB. */
export const ref = (token: string, gib: number) => ({ token, name: `${token}.jpg`, size: gib * GIB });

/** A deferred promise, for order checks. */
export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
