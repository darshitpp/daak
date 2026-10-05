import { NativeEventEmitter } from 'react-native';
import NativeDaakNotify from '@daak/rn-notify';
import type { InboxEntry } from '@daak/core';

export const DAK_RECEIVED_CATEGORY = 'daak.received';
export const DAK_RECEIVED_ACTIONS = ['daak.open', 'daak.share', 'daak.folder'] as const;
export type NotifyAction = (typeof DAK_RECEIVED_ACTIONS)[number];

/**
 * R37: the ids actually INSTALLED as buttons on the received category.
 *
 * "daak.folder" stays in DAK_RECEIVED_ACTIONS -- the vocabulary is frozen --
 * but it is withheld here because "reveal" has no implementation on either
 * platform, so a button that does nothing is worse than no button. Both native
 * sides install from their own list and withhold it the same way; add it back
 * here, to the Kotlin actionPending list, and to the Swift actionTitles table
 * in the same commit, once reveal exists.
 */
export const DAK_REGISTERED_ACTIONS = ['daak.open', 'daak.share'] as const;

export interface NotificationActionEvent {
  action: NotifyAction;
  /** The raw `InboxEntry` JSON the notification was posted with. */
  payload: string;
}

const EVENT = 'DaakNotifyEvent';

/**
 * Asks for the OS notification permission and installs the received category.
 *
 * Returns whether notifications may be posted, but a `false` is an ORDINARY
 * answer, not an error (R36): the inbox is the source of truth, so a denied
 * permission costs the user a banner, never a transfer. A module that cannot
 * ask at all (no foreground activity to prompt from) rejects, which is also
 * just `false` here -- startup must not die on it.
 *
 * `known` is an answer this process has ALREADY been given. Passing it skips
 * the ask and installs the categories anyway. That exists because a first
 * launch asks twice otherwise: the Permissions screen's alerts row calls this
 * when the user taps it, and startup calls it again moments later -- and on
 * Android POST_NOTIFICATIONS is a runtime permission that shows a system
 * prompt on every ask, so the user gets two prompts for one decision. iOS
 * would silently no-op the second, which is worse in a different way: the
 * screen's re-ask would then be unable to show anything at all.
 *
 * Categories are still installed on the known path: the category is not the
 * permission, and it has to exist before any banner is posted even when the
 * answer arrived earlier.
 */
export async function initNotifications(known?: boolean): Promise<boolean> {
  const granted =
    known ?? (await NativeDaakNotify.requestPermission().catch(() => false));
  // Registered even when denied: the category is not the permission, and a
  // user who grants later must not need a reinstall to get working actions.
  // Also caught, for the same reason: a category install that rejects would
  // reject startEngine, and no notification detail may take down app startup
  // (R36, which is not permission-specific).
  await NativeDaakNotify.registerCategories(
    JSON.stringify([{ id: DAK_RECEIVED_CATEGORY, actions: DAK_REGISTERED_ACTIONS }]),
  ).catch(() => false);
  return granted;
}

/**
 * Posts the "received" banner. Never throws (R36): the caller is the engine's
 * `inbox.received` handler, and an unhandled rejection there would take down a
 * process the user is receiving a file into. A dropped post is warned so it is
 * at least visible.
 */
export async function notifyReceived(entry: InboxEntry): Promise<void> {
  await NativeDaakNotify.post(
    entry.payloadId,
    'Daak',
    entry.summary,
    DAK_RECEIVED_CATEGORY,
    JSON.stringify(entry),
  ).catch((err: unknown) => {
    console.warn(`daak: no notification for ${entry.payloadId}: ${String(err)}`);
  });
}

/**
 * R33: the ONLY thing a notification action may do is reach one of these three
 * injected capabilities. `present` is the app's binding for `presentShare` --
 * the OS share sheet -- so there is deliberately no transport, no crypto and
 * no outbox import in this file: a second send path has nowhere to live.
 * `daak.share` is outbound-from-the-device, so the sheet is the correct end of
 * it; the engine's outbox owns sending and a notification action is not one.
 */
export interface NotificationActionHandlers {
  present: (request: { text?: string; urls?: string[]; mime?: string }) => Promise<void>;
  reveal: (path: string) => void;
  open: (payload: string) => void;
}

function parseEntry(payload: string): Partial<InboxEntry> | undefined {
  try {
    const parsed: unknown = JSON.parse(payload || '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Partial<InboxEntry>) : undefined;
  } catch {
    return undefined;
  }
}

export function handleNotificationAction(
  event: NotificationActionEvent,
  handlers: NotificationActionHandlers,
): void {
  const entry = parseEntry(event.payload);
  const paths = entry?.savedPaths ?? [];
  if (event.action === 'daak.share') {
    // Nothing to share is not an error worth a sheet: the entry saved no files.
    if (paths.length > 0) void handlers.present({ urls: paths });
  } else if (event.action === 'daak.folder') {
    // Revealing an empty path would open "Files" at nothing; leave it alone.
    if (paths.length > 0) handlers.reveal(paths[0]);
  } else if (event.action === 'daak.open') {
    handlers.open(event.payload);
  }
}

export function onNotificationAction(cb: (event: NotificationActionEvent) => void): () => void {
  // `NativeEventEmitter` needs the module only to pair its own add/remove
  // listener bookkeeping; the Spec declares both, so no cast is needed here.
  const emitter = new NativeEventEmitter(NativeDaakNotify);
  const sub = emitter.addListener(EVENT, cb);
  // A notification is the one event that can be tapped with NO listener: the
  // app was killed, or JS has not booted. RCTEventEmitter drops those, so the
  // native side stashes the last one and it is drained here.
  void NativeDaakNotify.consumePendingAction().then((raw) => {
    if (!raw) return;
    try {
      cb(JSON.parse(raw) as NotificationActionEvent);
    } catch {
      /* a corrupt stash must not break the subscription */
    }
  });
  return () => sub.remove();
}
