import { Alert } from 'react-native';
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
  relocateReceivedFiles,
  routeInboxEntry,
  startTransferForeground,
  stopTransferForeground,
  syncShortcutTargets,
} from '@daak/platform';
import type { DaakEngine, InboxEntry } from '@daak/core';
import type { InboundShareItem } from '@daak/platform';

export const engine: DaakEngine = createEngine();

// R91/R42: host-side SAS fan-out. PairingFlow (apps/mobile/src/PairingFlow.tsx)
// subscribes while the Pair tab is open; the ONE engine.on inside startEngine
// delivers pairing.sas events into this set. This is NOT a second subscription
// -- it is a fan-out from the single handler R42 pins.
const pairingSasListeners = new Set<(sas: string, peerDeviceId: string) => void>();

export function onPairingSas(cb: (sas: string, peerDeviceId: string) => void): () => void {
  pairingSasListeners.add(cb);
  return () => {
    pairingSasListeners.delete(cb);
  };
}

// peer.incompatible fan-out, same shape and same single-subscription rule as
// the SAS above (R42/R91). The engine emits this whenever a peer advertises a
// protocol version this build refuses; without a listener it reached the store
// and nowhere else, so UpdateRequiredScreen had no way to be shown.
//
// A peer re-announces on a timer, so this fires repeatedly for a peer that is
// still out of step. The route is therefore opened by App only when the list
// GROWS past what it already showed, not on every tick.
const incompatibleListeners = new Set<(peer: IncompatiblePeer) => void>();

export interface IncompatiblePeer {
  peerDeviceId: string;
  peerName: string;
  peerVersion: number;
  ourVersion: number;
}

export function onIncompatiblePeer(cb: (peer: IncompatiblePeer) => void): () => void {
  incompatibleListeners.add(cb);
  return () => {
    incompatibleListeners.delete(cb);
  };
}

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

/**
 * The REAL answer initNotifications() gave the last time startup ran, kept so
 * the Permissions screen can render a fact instead of guessing.
 *
 * startEngine calls initNotifications and threw the result away; the prototype's
 * Permissions screen needs to know whether alerts are actually granted. Rather
 * than ask twice (an iOS prompt is not re-shown, and a second ask would be a
 * request whose answer nobody can change), the value is recorded here and
 * exposed. Undefined before startup and after a rejected ask -- which is
 * indistinguishable from never having asked, and is rendered as such.
 */
let notificationsGranted: boolean | undefined;

export function notificationGrant(): boolean | undefined {
  return notificationsGranted;
}

/**
 * Records the OS's answer without asking.
 *
 * The Permissions screen is the ONE place a first launch is meant to ask:
 * asking there is a deliberate tap on a row that names what is being asked
 * for. startup then runs initNotifications again, and on Android that is a
 * SECOND system prompt for the same decision. Passing the recorded answer
 * back in makes startup reuse it, so the ask happens exactly once per launch
 * no matter which step ran first.
 *
 * undefined deliberately means "not answered yet", so the first real caller
 * still asks. Passing a value is a claim that the OS already gave it, which is
 * only ever true here -- it comes from this module's own initNotifications
 * call, not from a guess.
 */
export function recordNotificationGrant(granted: boolean | undefined): void {
  notificationsGranted = granted;
}

export function startEngineOnce(): Promise<void> {
  // Idempotent for the process lifetime, not merely per call: two engines in
  // one process means two identities and two discovery stacks on the LAN.
  started ??= startEngine();
  return started;
}

/**
 * Move a received payload's files, THEN post its banner with the locations the
 * move produced.
 *
 * A notification is a SNAPSHOT: its payload JSON is baked into the
 * notification's extras at post time. Posting before the move baked in paths
 * that the move then DELETED, so the banner's Share built a URI for a file that
 * was gone and the sheet opened with nothing attached. The move therefore runs
 * first, and the banner carries where the files really are.
 *
 * Never throws: it runs inside the app's ONE engine event handler, where an
 * unhandled rejection would kill the subscription and with it every later
 * notification and pairing publish.
 *
 * ponytail: the banner now WAITS for the move. A slow or hung SAF move delays
 * the banner, and a move that never returns drops it. That is the price of a
 * path that is correct. Upgrade to a placeholder banner rewritten when the move
 * settles, if the delay is ever felt.
 */
async function notifyAfterRelocate(engine: DaakEngine, entry: InboxEntry): Promise<void> {
  const moved = await relocateReceivedFiles(engine, entry);
  await notifyReceived(moved ? { ...entry, savedPaths: moved } : entry);
}

export async function startEngine(): Promise<void> {
  await engine.start();
  // R36: a denied permission is an ordinary answer, not a startup failure. The
  // banner is lost; the transfer is not. The RESULT is recorded rather than
  // discarded, so the Permissions screen reports the OS's own answer.
  notificationsGranted = await initNotifications(notificationsGranted);
  // R26: the peer list has to reach the App Group pairedDevices key, because
  // DaakIntentBridge.devices() is what answers Siri's entity query and it has no
  // other way to learn it. syncShortcutTargets is the only writer on both
  // platforms (Android dynamic shortcuts, iOS App Group defaults). Re-run on
  // pairing.done so a fresh peer shows up in Siri without an app relaunch.
  const publish = () =>
    // Only paired devices: discovery lists peers the engine refuses to send to.
    engine.devices().then((all) => syncShortcutTargets(all.filter((d) => d.paired)), () => {
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
  // chunk, so membership is tracked here rather than in the handler. Cleared on
  // any terminal transfer event, which is the only place it can be wrong: a
  // transfer that ends without done/failed leaves the service up. That is a
  // stale notification, not a lost send, and a stop() would race the next
  // transfer's start(). R87: this note used to call the tracking a boolean
  // latch and a per-transfer refcount future work, which is what the next
  // paragraph says is already done; a reader taking it at face value restores
  // the boolean.
  // A SET, not a boolean, because concurrent transfers already arrive: the
  // outbox drains rows in a loop and several peers can be online at once. One
  // shared boolean let A's done stop the service while B was still sending,
  // leaving B unprotected until its next chunk -- the whole stall, on a peer
  // that has gone quiet. Start on 0 -> 1, stop on 1 -> 0; the OS sees one start
  // per overlap window rather than one per chunk. A transfer that ends
  // without done/failed leaves its id in the set, which is a stale
  // notification and not a lost send (the outbox retries).
  const inFlight = new Set<string>();
  unsubscribeEngine = engine.on((e) => {
    // The compatibility signal, on the ONE subscription like every other
    // event. A peer that is out of step is otherwise INVISIBLE: the engine
    // skips it, so it never appears in devices() and the user sees an empty
    // network with no explanation -- which is exactly what the update-required
    // screen exists to explain.
    if (e.type === 'peer.incompatible') {
      for (const cb of [...incompatibleListeners]) cb(e);
      return;
    }
    // R91 (host half of QR pairing): the SAS for an INBOUND pairing arrives
    // here, on the ONE subscription, and is fanned out to PairingFlow. The
    // joiner's SAS comes back from engine.pair, so only the host reads this.
    if (e.type === 'pairing.sas') {
      for (const cb of [...pairingSasListeners]) cb(e.sas, e.peerDeviceId);
      return;
    }
    if (e.type === 'pairing.done') void publish();
    // A revoked peer must leave the share sheet and Siri now, not at next launch.
    if (e.type === 'pairing.revoked') void publish();
    // R42: BOTH effects on the ONE subscription. routeInboxEntry copies a text
    // payload to the clipboard; a file payload is deliberately inert until the
    // UI owns reveal. Neither throws, and neither is a send: the engine's
    // outbox owns every Daak-to-Daak transfer.
    if (e.type === 'inbox.received') {
      void routeInboxEntry(e.payload, realReceiveDeps);
      // R42p: a file the user asked to keep somewhere else is MOVED there now,
      // and the row is told where. Here, on the ONE subscription, for the same
      // reason every other branch is here. The BANNER is posted after it, and
      // the ordering is load-bearing -- see notifyAfterRelocate.
      void notifyAfterRelocate(engine, e.payload);
    }
    // R42/GAP 3: the plan's wireBackground opens a SECOND engine.on to do this.
    // It lives here, on the ONE subscription, for the reason every other branch
    // is here. Android only; iOS resolves both as no-ops natively.
    if (e.type === 'transfer.progress' && !inFlight.has(e.transferId)) {
      inFlight.add(e.transferId);
      if (inFlight.size > 1) return;
      void startTransferForeground('Sending with Daak');
    }
    if (e.type === 'transfer.done' || e.type === 'transfer.failed') {
      if (inFlight.delete(e.transferId) && inFlight.size === 0) {
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
 * The OS share-sheet drain. consumePendingShare is all-or-nothing natively: it
 * drains every batch and deletes the metadata that names the item, so a drain
 * MUST have a consumer for the item it hands back or those bytes are lost. The
 * consumer is App.tsx's Send composer (all three arms now route: text and file
 * into the draft, intent-send is filtered here because bootstrap already sent
 * it from its own non-destructive subdir).
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
  confirm: ConfirmIntentSend,
): Promise<void> {
  const devices = await engine.devices();
  const known = new Set(devices.map((d) => d.deviceId));
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
    // Another app chose this peer and this text. Nothing leaves the device until
    // the user has seen both and agreed.
    const name = devices.find((d) => d.deviceId === item.deviceId)?.name ?? 'a paired device';
    if (!(await confirm(name, item.text ?? ''))) continue;
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
export async function drainIntentSends(
  engine: DaakEngine,
  confirm: ConfirmIntentSend = confirmIntentSend,
): Promise<void> {
  await sendIntentItems(engine, await consumeIntentSends(), confirm);
}

/** Asks the user whether to send `text` to the peer `name`. Resolves true on Send. */
export type ConfirmIntentSend = (name: string, text: string) => Promise<boolean>;

const confirmIntentSend: ConfirmIntentSend = (name, text) =>
  new Promise((resolve) => {
    Alert.alert(
      `Send to ${name}?`,
      text.length > 300 ? `${text.slice(0, 300)}…` : text,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Send', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });

/**
 * Routes a tapped action. R33: `daak.share` is wired to `presentShare`, the
 * app's EXISTING binding for the OS share sheet. This calls no transport and
 * imports no crypto -- the engine's outbox owns every Daak-to-Daak send, and a
 * notification action is not one. `present` is the ONLY outbound capability
 * the handler can reach.
 *
 * Wired by App.tsx, because the INSTALLED category -- [Open] and [Share] --
 * had no call site at all and a tap was silently dropped. `reveal` is the real
 * revealInFileManager rather than a no-op even though daak.folder is still
 * withheld from the installed set on both native sides (R37): iOS resolves
 * false by design (R41) and Android opens a FileProvider viewer, so the handler
 * is already honest and nothing changes if the button is re-registered.
 */
export function wireNotificationActions(
  reveal: (path: string) => void,
  open: (payload: string) => void,
): () => void {
  return onNotificationAction((event) =>
    handleNotificationAction(event, { present: presentShare, reveal, open }),
  );
}
