import { useEffect, useState } from 'react';
import type { DaakEngine, QuarantineReport } from '@daak/core';

/**
 * How often the panel reads the held-back list. The user can delete a held file
 * in the full window, and the engine sends no event for that.
 */
export const HELD_POLL_MS = 5000;

/**
 * The newest held-back item, or null. `listQuarantineReports()` returns the
 * newest arrival first, so the first entry is the one the panel shows.
 * A failed read keeps the last value.
 */
export function useHeldBack(engine: DaakEngine): QuarantineReport | null {
  const [report, setReport] = useState<QuarantineReport | null>(null);
  useEffect(() => {
    let live = true;
    const read = () =>
      void engine.listQuarantineReports().then(
        (list) => {
          if (live) setReport(list[0] ?? null);
        },
        () => {},
      );
    read();
    const off = engine.on((e) => {
      if (
        e.type === 'transfer.item' ||
        e.type === 'transfer.done' ||
        e.type === 'transfer.failed' ||
        e.type === 'inbox.received'
      ) {
        read();
      }
    });
    const id = setInterval(read, HELD_POLL_MS);
    return () => {
      live = false;
      off();
      clearInterval(id);
    };
  }, [engine]);
  return report;
}
