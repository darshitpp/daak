import { consumeIntentSends, consumePendingShare, createEngine, syncShortcutTargets } from '@daak/platform';
import type { DaakEngine } from '@daak/core';
import type { InboundShareItem } from '@daak/platform';

export const engine: DaakEngine = createEngine();

// Re-entry handle for the pairing.done subscription. startEngine is *meant* to
// be called once, but a comment is not an invariant -- a remount or a hot
// reload would otherwise leave every earlier subscription live and republish
// the peer list N times per pairing.done.
let unsubscribePairing: (() => void) | undefined;

// Still nothing calls this: `engine` is constructed eagerly at import so the
// TurboModule resolves, but it is never started until the app owns a
// lifecycle. That is what R22's "App must not drain on mount" test pins --
// App.tsx renders and nothing else. When an owner appears it must call this once.
export async function startEngine(): Promise<void> {
  await engine.start();
  // R26: the peer list has to reach the App Group pairedDevices key, because
  // DaakIntentBridge.devices() is what answers Siri's entity query and it has no
  // other way to learn it. syncShortcutTargets is the only writer on both
  // platforms (Android dynamic shortcuts, iOS App Group defaults). Re-run on
  // pairing.done so a fresh peer shows up in Siri without an app relaunch.
  const publish = () =>
    engine.devices().then(syncShortcutTargets, () => {
      /* the engine is not up yet; startEngine's own publish will follow */
    });
  await publish();
  unsubscribePairing?.();
  unsubscribePairing = engine.on((e) => {
    if (e.type === 'pairing.done') void publish();
  });
  // R25: the ONE real send call site. ShareTargetActivity and the Siri intent
  // both stage into share-inbox/intent-sends/ and launch/foreground the app,
  // so draining here picks them up. consumePendingShare is NOT called: see
  // drainInbound, which stays unwired for the same reason.
  // ponytail: this runs once, right after start(). A share that lands while the
  // engine is still coming up is not drained until the next start(), so the
  // item stays on disk rather than being lost. Upgrade if that window is real
  // in use: subscribe to the Darwin-notification wakeup DaakShare already
  // observes instead of polling once per launch.
  await drainIntentSends(engine);
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
 * guessed at. This IS the send call site (R25): it is reached only through
 * drainIntentSends below, which uses a drain that cannot delete a text/file
 * batch.
 */
export async function sendIntentItems(
  engine: DaakEngine,
  items: InboundShareItem[],
): Promise<void> {
  const known = new Set((await engine.devices()).map((d) => d.deviceId));
  for (const item of items) {
    if (item.kind !== 'intent-send') continue;
    // ShareTargetActivity is exported, so any app on the device can hand us an
    // arbitrary deviceId. An unknown peer can never resolve; enqueueing it
    // anyway fills the outbox with rows that can only fail.
    if (!known.has(item.deviceId)) {
      // R31: refusing is the R28 security property and stays. The drain has
      // ALREADY deleted the staged bytes, though, so a share aimed at a peer
      // paired seconds earlier -- or one racing engine.start() -- would vanish
      // with no trace. Re-staging needs a new native write path back into the
      // App Group / cache dir; a warning makes the same loss observable for
      // one line, which is the cheaper honest half.
      console.warn(
        `daak: refused intent-send to unpaired device ${item.deviceId}; the staged share was already deleted by the drain`,
      );
      continue;
    }
    // A drain already DELETED the staged file, so one rejected send must not
    // abandon the rest of the batch: the items are gone from disk either way,
    // and the honest response is to try them all.
    try {
      await engine.send({ peerDeviceId: item.deviceId, text: item.text });
    } catch {
      /* dropped: the outbox never saw it and the batch is already retired */
    }
  }
}

/**
 * The R25 send call site: drain ONLY the intent-send subdir and enqueue each
 * item through the outbox. This is not a blocking transport send --
 * `engine.send` returns `queued: true` and the outbox owns delivery.
 *
 * consumePendingInbox is deliberately NOT used: it is all-or-nothing and would
 * delete the text/file batches Task 6 staged, orphaning bytes that nothing
 * routes until Task 11. drainInbound above stays unwired for that reason.
 */
export async function drainIntentSends(engine: DaakEngine): Promise<void> {
  await sendIntentItems(engine, await consumeIntentSends());
}
