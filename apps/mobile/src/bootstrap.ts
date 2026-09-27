import {
  consumeIntentSends,
  consumePendingShare,
  createEngine,
  initBackgroundSync,
  handleNotificationAction,
  initNotifications,
  notifyReceived,
  onNotificationAction,
  presentShare,
  realReceiveDeps,
  routeInboxEntry,
  startTransferForeground,
  stopTransferForeground,
  syncShortcutTargets,
} from '@daak/platform';
import type { DaakEngine } from '@daak/core';
import type { InboundShareItem } from '@daak/platform';

export const engine: DaakEngine = createEngine();

// Re-entry handle for the pairing.done subscription. startEngine is *meant* to
// be called once, but a comment is not an invariant -- a remount or a hot
// reload would otherwise leave every earlier subscription live and republish
// the peer list N times per pairing.done, and post a banner N times per
// receive. ONE subscription, for both reasons: two live subscriptions for two
// unrelated reasons is the shape that turns into N per remount.
let unsubscribeEngine: (() => void) | undefined;

// The app lifecycle owner. Task 10 lands it: App.tsx calls this once from a
// mount effect. It stays OUT of the module body so a Fast Refresh or a remount
// cannot start a second engine, and it still does NOT drain the text/file share
// inbox (R22) -- see drainInbound below, which stays unwired for the same
// reason it has since Task 6.
let started: Promise<void> | undefined;

export function startEngineOnce(): Promise<void> {
  // Idempotent for the process lifetime, not merely per call: two engines in
  // one process means two identities and two discovery stacks on the LAN.
  started ??= startEngine();
  return started;
}

export async function startEngine(): Promise<void> {
  await engine.start();
  // R36: a denied permission is an ordinary answer, not a startup failure. The
  // banner is lost; the transfer is not.
  await initNotifications();
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
  // Books the first iOS background slot and installs the Android periodic job.
  // Never throws (see initBackgroundSync), so a WorkManager that will not
  // initialise cannot take the engine down with it.
  await initBackgroundSync();
  // ONE engine subscription for the app's whole lifetime, handling every event
  // the app reacts to. A second one for inbox.received would double-post a
  // banner per receive AND break startEngineSubscription's invariant, which is
  // right: two live subscriptions for two unrelated reasons is the shape that
  // turns into N per remount.
  unsubscribeEngine?.();
  // A foreground-service start per progress event would be one OS start per
  // chunk, so the flag is latched here rather than in the handler. Cleared on
  // any terminal transfer event, which is the only place it can be wrong: a
  // transfer that ends without done/failed leaves the service up. That is a
  // stale notification, not a lost send, and a stop() would race the next
  // transfer's start(). ponytail: latch; upgrade to a per-transfer refcount if
  // concurrent transfers ever arrive.
  let transferForegroundUp = false;
  unsubscribeEngine = engine.on((e) => {
    if (e.type === 'pairing.done') void publish();
    // R42: BOTH effects on the ONE subscription. routeInboxEntry copies a text
    // payload to the clipboard; a file payload is deliberately inert until the
    // UI owns reveal. Neither throws, and neither is a send: the engine's
    // outbox owns every Daak-to-Daak transfer.
    if (e.type === 'inbox.received') {
      void routeInboxEntry(e.payload, realReceiveDeps);
      void notifyReceived(e.payload);
    }
    // R42/GAP 3: the plan's wireBackground opens a SECOND engine.on to do this.
    // It lives here, on the ONE subscription, for the reason every other branch
    // is here. Android only; iOS resolves both as no-ops natively.
    if (e.type === 'transfer.progress' && !transferForegroundUp) {
      transferForegroundUp = true;
      void startTransferForeground('Sending with Daak');
    }
    if (e.type === 'transfer.done' || e.type === 'transfer.failed') {
      if (transferForegroundUp) {
        transferForegroundUp = false;
        void stopTransferForeground();
      }
    }
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

/**
 * Routes a tapped action. R33: `daak.share` is wired to `presentShare`, the
 * app's EXISTING binding for the OS share sheet. This calls no transport and
 * imports no crypto -- the engine's outbox owns every Daak-to-Daak send, and a
 * notification action is not one. `present` is the ONLY outbound capability
 * the handler can reach.
 *
 * DELIBERATELY NOT CALLED YET, same reason as drainInbound: `reveal` has no
 * implementation on either platform (iOS needs a QuickLook preview, Android a
 * ACTION_VIEW intent on a FileProvider URI), so every caller today would have to
 * pass a no-op and a tapped "Show in folder" would silently do nothing. That is
 * also why R37 withholds daak.folder from the INSTALLED category on both native
 * sides: the button is not shown, so the missing reveal is unreachable. Wire
 * this when the UI owns reveal, and re-register the button in the same commit.
 */
export function wireNotificationActions(
  reveal: (path: string) => void,
  open: (payload: string) => void,
): () => void {
  return onNotificationAction((event) =>
    handleNotificationAction(event, { present: presentShare, reveal, open }),
  );
}
