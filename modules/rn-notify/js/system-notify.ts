// Desktop notifications. NOT a second notification path: the inbox is still the
// source of truth, exactly as packages/platform/src/notify.ts R36 records for
// mobile. This posts a banner and reports WHICH action was tapped; it does not
// transport, encrypt, or send.
//
// Deep import of ./actions and ./NativeDaakSystemNotify rather than the package
// barrel, for the reason modules/rn-share/js/index.ts records: the barrel is
// mobile-reachable and a re-export is an EAGER require.
import { NativeEventEmitter } from 'react-native';
import NativeDaakSystemNotify from './NativeDaakSystemNotify';
import { buildNotification } from './actions';
import type { DesktopNotification, InboxNotificationEntry, NotifyAction } from './actions';

const EVENT = 'DaakSystemNotifyAction';

// Takes the structural InboxNotificationEntry, not @daak/core's InboxEntry, so
// this module needs no "dependencies" entry -- read actions.ts. A real InboxEntry
// (the engine's inbox.received payload) is assignable to it, so callers are
// unaffected.
export function notifyInbox(entry: InboxNotificationEntry): Promise<void> {
  const notification: DesktopNotification = buildNotification(entry);
  return NativeDaakSystemNotify.notify(JSON.stringify(notification));
}

// LAZY on purpose, and this is the plan's first real bug. The plan builds
// `const emitter = new NativeEventEmitter(NativeDaakSystemNotify)` at MODULE
// SCOPE, in the barrel. That eagerly evaluates NativeDaakSystemNotify.ts, whose
// getEnforcing('DaakSystemNotify') THROWS on iOS/Android where only 'DaakNotify'
// is registered -- so it would take the mobile app down before its first render,
// which is the exact defect Task 5 recorded after it shipped it in rn-share
// (R5 Blocker 1). Two independent reasons the emitter cannot live here:
//   1. this file is reachable from apps/mobile paths at launch;
//   2. even on desktop a caller may import notifyInbox without ever subscribing,
//      and a native emitter it does not use is not free.
// So it is built on first subscribe and reused after.
let emitter: NativeEventEmitter | undefined;

export function onNotifyAction(
  handler: (event: { actionId: NotifyAction['id']; payloadId: string }) => void,
): () => void {
  emitter ??= new NativeEventEmitter(NativeDaakSystemNotify as never);
  const subscription = emitter.addListener(EVENT, handler);
  return () => subscription.remove();
}

export { buildNotification, inboxActions } from './actions';
export type { DesktopNotification, InboxNotificationEntry, NotifyAction } from './actions';
