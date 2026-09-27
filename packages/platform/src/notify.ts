import { NativeEventEmitter } from 'react-native';
import NativeDaakNotify from '@daak/rn-notify';
import type { InboxEntry } from '@daak/core';

export const DAK_RECEIVED_CATEGORY = 'daak.received';
export const DAK_RECEIVED_ACTIONS = ['daak.open', 'daak.share', 'daak.folder'] as const;
export type NotifyAction = (typeof DAK_RECEIVED_ACTIONS)[number];

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
 */
export async function initNotifications(): Promise<boolean> {
  const granted = await NativeDaakNotify.requestPermission().catch(() => false);
  // Registered even when denied: the category is not the permission, and a
  // user who grants later must not need a reinstall to get working actions.
  await NativeDaakNotify.registerCategories(
    JSON.stringify([{ id: DAK_RECEIVED_CATEGORY, actions: DAK_RECEIVED_ACTIONS }]),
  );
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

export function cancelNotification(id: string): Promise<void> {
  return NativeDaakNotify.cancel(id);
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
