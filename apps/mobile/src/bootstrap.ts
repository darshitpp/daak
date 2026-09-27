import { consumePendingShare, createEngine } from '@daak/platform';
import type { DaakEngine } from '@daak/core';
import type { InboundShareItem } from '@daak/platform';

export const engine: DaakEngine = createEngine();

// Nothing calls this yet either: `engine` is constructed eagerly at import, so
// the TurboModule resolves, but it is never started until the app owns a
// lifecycle. See the R22 note on drainInbound below for why the mount-time
// drain that used to live here was removed.
export async function startEngine(): Promise<void> {
  await engine.start();
}

/**
 * DELIBERATELY UNWIRED (R22). Do not call this from a mount effect yet.
 *
 * Nothing consumes a text/file item yet, and consumePendingShare is
 * all-or-nothing natively: it drains every batch and deletes the metadata that
 * names the item. Draining on mount would hand back a text/file item nobody
 * routes, throw its batch away, and leave the bytes unreferenced in the App
 * Group / cache dir. That is silent data loss on the inbound share path, and
 * the staged-and-intact batch is strictly the better resting state.
 *
 * Task 11 owns the composer route that can consume them; Tasks 7 and 9 own the
 * intent-send arm. Wire the drain only when a caller exists for all three
 * InboundShareItem arms.
 *
 * This is NOT a send: the engine's outbox owns delivery, so a drain on its own
 * never contacts a peer. A batch the native side could not parse is dropped
 * there, not here, so this never rejects.
 */
export async function drainInbound(
  onItems: (items: InboundShareItem[]) => void,
): Promise<void> {
  const items = await consumePendingShare();
  if (items.length > 0) onItems(items);
}

/**
 * Direct Share (Task 7) names a target device in the share intent, so this arm
 * is the only one with a destination already chosen. Text/file items have no
 * destination and no peer picker exists yet, so they are skipped rather than
 * guessed at. Also unwired -- see drainInbound above.
 */
export async function sendIntentItems(
  engine: DaakEngine,
  items: InboundShareItem[],
): Promise<void> {
  for (const item of items) {
    if (item.kind !== 'intent-send') continue;
    await engine.send({ peerDeviceId: item.deviceId, text: item.text });
  }
}
