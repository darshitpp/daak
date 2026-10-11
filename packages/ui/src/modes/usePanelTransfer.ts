import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaakEngine, TransferSummary } from '@daak/core';
import { isRunning, newestRunningOut } from './panel-model';

/** How often the panel reads the transfer while it runs. The engine emits no progress event. */
export const PANEL_POLL_MS = 700;

export interface PanelSend {
  transferId: string;
  peerDeviceId: string;
  /** The file name or the note text. Empty for a transfer that the panel adopted. */
  label: string;
}

/**
 * The transfer that the panel shows.
 *
 * The source of truth is `engine.listTransfers()`. The store fills a transfer
 * row only on `transfer.progress`, and the engine never emits it.
 *
 * Nothing here cancels a transfer on unmount. The engine runs in the app
 * process, so a closed panel must not stop a send. A new mount adopts the
 * newest running outbound transfer, so the panel shows it again.
 */
export function usePanelTransfer(engine: DaakEngine) {
  const [send, setSend] = useState<PanelSend | null>(null);
  const [row, setRow] = useState<TransferSummary | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const sendRef = useRef(send);
  sendRef.current = send;
  const rowRef = useRef(row);
  rowRef.current = row;
  // `begin` and `clear` raise this number. A read that started before either call
  // holds a stale list. Without the check, a poll that is in flight when `stop`
  // clears the transfer would adopt the old running row again for one cycle.
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const started = generation.current;
    try {
      const all = await engine.listTransfers();
      if (!mounted.current || generation.current !== started) return;
      const current = sendRef.current;
      if (current === null) {
        const running = newestRunningOut(all);
        if (running !== undefined) {
          sendRef.current = { transferId: running.transferId, peerDeviceId: running.peerDeviceId, label: '' };
          setSend(sendRef.current);
          setRow(running);
        }
        return;
      }
      const mine = all.find((t) => t.transferId === current.transferId);
      // A row the engine still lists is NOT gone -- UNLESS a cancel wrote
      // 'canceled' on it. A cancel KEEPS the row, so its state is the only
      // cancel signal the panel gets. Do not keep pinning a canceled transfer.
      if (mine !== undefined && mine.state !== 'canceled') {
        setRow(mine);
        return;
      }
      // Gone: absent from the list, or present as 'canceled'. Adopt the newest
      // running outbound transfer, or clear when none runs. An absent row with
      // no running state left is a stale read, not a cancel, so keep the panel.
      const canceled = mine !== undefined;
      if (!canceled && !(rowRef.current !== null && isRunning(rowRef.current))) return;
      const running = newestRunningOut(all);
      if (running !== undefined) {
        sendRef.current = { transferId: running.transferId, peerDeviceId: running.peerDeviceId, label: '' };
        setSend(sendRef.current);
      } else {
        sendRef.current = null;
        setSend(null);
      }
      setRow(running ?? null);
    } catch {
      // A failed read keeps the last row. The next event or poll reads again.
    }
  }, [engine]);

  useEffect(() => {
    void refresh();
    return engine.on((e) => {
      if (e.type === 'transfer.failed' && e.transferId === sendRef.current?.transferId) setFailure(e.error);
      if (e.type.startsWith('transfer.') || e.type === 'outbox.queued') void refresh();
    });
  }, [engine, refresh]);

  const polling = send !== null && (row === null || isRunning(row));
  useEffect(() => {
    if (!polling) return;
    const id = setInterval(() => void refresh(), PANEL_POLL_MS);
    return () => clearInterval(id);
  }, [polling, refresh]);

  const begin = useCallback(
    (s: PanelSend) => {
      generation.current += 1;
      sendRef.current = s;
      setSend(s);
      setRow(null);
      setFailure(null);
      void refresh();
    },
    [refresh],
  );

  const clear = useCallback(() => {
    generation.current += 1;
    sendRef.current = null;
    setSend(null);
    setRow(null);
    setFailure(null);
  }, []);

  /** Resolves an error message, or null when the transfer stopped. */
  const stop = useCallback(async (): Promise<string | null> => {
    const current = sendRef.current;
    if (current === null) return null;
    try {
      await engine.cancel(current.transferId);
    } catch (e) {
      return e instanceof Error ? e.message : 'The transfer did not stop.';
    }
    clear();
    return null;
  }, [engine, clear]);

  const retry = useCallback(async (): Promise<string | null> => {
    const current = sendRef.current;
    if (current === null) return null;
    try {
      await engine.retry(current.transferId);
    } catch (e) {
      return e instanceof Error ? e.message : 'The transfer did not start again.';
    }
    setFailure(null);
    await refresh();
    return null;
  }, [engine, refresh]);

  return { send, row, failure, begin, clear, stop, retry };
}
