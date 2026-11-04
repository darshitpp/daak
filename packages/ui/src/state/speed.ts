import { useEffect, useRef, useState } from 'react';

const TAU_MS = 1500;
const MIN_GAP_MS = 100;
const WARMUP_MS = 1000;
const STALL_MS = 3000;
const TICK_MS = 1000;

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

/** Format a rate with 1 digit after the point. Example: `12.3 MiB/s`. */
export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec >= GIB) return `${(bytesPerSec / GIB).toFixed(1)} GiB/s`;
  if (bytesPerSec >= MIB) return `${(bytesPerSec / MIB).toFixed(1)} MiB/s`;
  return `${(bytesPerSec / KIB).toFixed(1)} KiB/s`;
}

/** Format the time left. Return null at 100 h or more. */
export function formatEta(secondsLeft: number): string | null {
  let s = Math.max(0, Math.round(secondsLeft));
  if (s > 30 && s < 60) s = Math.round(s / 5) * 5;
  if (s < 60) return `${s} s left`;
  if (secondsLeft >= 100 * 3600) return null;
  const min = Math.round(s / 60);
  if (min < 60) return `about ${min} min left`;
  return `about ${Math.round(s / 3600)} h left`;
}

type Window = {
  lastT: number;
  lastBytes: number;
  warmStart: number;
  rate: number | null;
};

const speedText = (rate: number, eta: number | null): string => {
  const left = eta === null ? null : formatEta(eta);
  return left === null ? formatSpeed(rate) : `${formatSpeed(rate)} · ${left}`;
};

/**
 * Compute the transfer speed from progress samples.
 * The rate is a time-weighted moving average over the difference between
 * two samples. The hook does not read the store.
 */
export function useTransferSpeed(
  transferId: string,
  bytesDone: number,
  bytesTotal: number,
  active: boolean,
): { bytesPerSec: number; etaSeconds: number | null; text: string | null } {
  const win = useRef<Window | null>(null);
  const total = useRef(bytesTotal);
  total.current = bytesTotal;
  const [text, setText] = useState<string | null>(null);

  // Read the window at `now`. Return the visible rate, or null.
  const visible = (now: number): { rate: number; eta: number | null } | null => {
    const w = win.current;
    if (!w || w.rate === null) return null;
    if (now - w.lastT >= STALL_MS) return null;
    if (w.lastT - w.warmStart < WARMUP_MS) return null;
    const left = total.current - w.lastBytes;
    const eta = w.rate > 0 && left > 0 ? left / w.rate : null;
    return { rate: w.rate, eta };
  };

  const publish = (now: number) => {
    const v = visible(now);
    setText(v ? speedText(v.rate, v.eta) : null);
  };

  // Reset the window when the transfer changes or stops.
  useEffect(() => {
    win.current = null;
    setText(null);
  }, [transferId, active]);

  // Add a sample each time `bytesDone` changes.
  useEffect(() => {
    if (!active) return;
    const now = Date.now();
    const w = win.current;
    if (!w || now - w.lastT >= STALL_MS) {
      // First sample, or restart after a stall. This sample is only a seed.
      win.current = { lastT: now, lastBytes: bytesDone, warmStart: now, rate: null };
    } else {
      const dt = now - w.lastT;
      if (dt < MIN_GAP_MS) return;
      const inst = Math.max(0, (bytesDone - w.lastBytes) / (dt / 1000));
      const alpha = 1 - Math.exp(-dt / TAU_MS);
      w.rate = w.rate === null ? inst : w.rate + alpha * (inst - w.rate);
      w.lastT = now;
      w.lastBytes = bytesDone;
    }
    publish(now);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytesDone, transferId, active]);

  // Detect a stall. No event arrives during a stall.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => publish(Date.now()), TICK_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, transferId]);

  const v = text === null ? null : visible(Date.now());
  return {
    bytesPerSec: v ? v.rate : 0,
    etaSeconds: v ? v.eta : null,
    text,
  };
}
