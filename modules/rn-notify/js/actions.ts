// The desktop notification's action model. Deliberately a SEPARATE file from
// system-notify.ts even though the brief suggested folding it in, and the reason
// is TDD, not tidiness: this file imports NOTHING, so test/actions.spec.ts can
// import it in plain Node under vitest with no alias, no stub and no
// TurboModuleRegistry. The moment buildNotification lives next to notifyInbox it
// would need one (see system-notify.ts).
//
// NOT on the mobile-reachable barrel (modules/rn-notify/js/index.ts) -- read the
// comment there.

// The three fields of @daak/core's InboxEntry that buildNotification reads,
// declared as a local structural subset rather than imported.
//
// This is the reason this module has NO entry in "dependencies". The plan's
// package.json adds { "@daak/core": "workspace:*" }, but this package is a
// dependency of packages/platform and apps/mobile, and the Task 5 precedent set
// the bar the other way: modules/rn-share/package.json has NO "dependencies"
// block at all, and its js/items.ts declares SharePayload locally for the same
// reason. A structural subset is assignable FROM the real InboxEntry without a
// dependency edge, so callers keep passing engine values unchanged and this
// module stays a leaf.
//
// Only the read fields are required. The engine's InboxEntry has eight fields
// (payloadId, transferId, peerDeviceId, kind, itemCount, summary, receivedAt,
// savedPaths -- packages/core/src/engine/types.ts:11-26) and all are required,
// but requiring all eight here would mean a test fixture has to invent
// transferId and receivedAt to prove a title pluralises. The engine is the
// source of truth for the entry; this is the projection of it that the banner
// needs, and a wider InboxEntry satisfies it for free.
export interface InboxNotificationEntry {
  payloadId: string;
  itemCount: number;
  summary: string;
}

export interface NotifyAction {
  id: 'open' | 'share' | 'show';
  label: string;
}

export interface DesktopNotification {
  payloadId: string;
  category: 'daak.inbox';
  title: string;
  body: string;
  actions: NotifyAction[];
}

export function inboxActions(): NotifyAction[] {
  // R37, applied to desktop the way packages/platform/src/notify.ts:10-18
  // applies it to mobile, and with the same precedent in
  // modules/rn-notify/ios/DaakNotify.swift:26-33, where 'daak.folder' is named
  // in the vocabulary and deliberately NOT installed.
  //
  // 'share' is WITHHELD: re-sharing a received payload is the mobile DaakShare
  // outbound path, and the desktop inbound inbox has no re-share surface at
  // all. Installing it would hand the user a button that foregrounds the app
  // and then does nothing.
  //
  // 'show' ("Show in folder") is WITHHELD: reveal has no implementation, and
  // its label promises Finder. The honest options were to implement reveal or
  // to drop the button, and Phase 6 ruled the button out. It was briefly
  // aliased onto openDashboard, which is a lie by the label.
  //
  // TO ADD EITHER BACK, in ONE commit, all four of:
  //   1. this list,
  //   2. the matching action registration in the daak.inbox category table in
  //      macos/RNNotify.mm,
  //   3. the real effect in apps/desktop/src/notify.ts's planNotifyAction and
  //      its NotifyHost,
  //   4. the withhold assertions in modules/rn-notify/test/actions.spec.ts.
  //
  // A button is a promise. Withhold it until there is something to keep.
  return [
    { id: 'open', label: 'Open' },
  ];
}

// The engine's InboxEntry has a REAL itemCount -- the plan's `as any` fixture
// was hiding a field that exists, and `unit` below is the only reason this
// function needs a number at all.
export function buildNotification(entry: InboxNotificationEntry): DesktopNotification {
  const unit = entry.itemCount === 1 ? 'item' : 'items';
  return {
    payloadId: entry.payloadId,
    category: 'daak.inbox',
    title: `Received ${entry.itemCount} ${unit}`,
    body: entry.summary,
    actions: inboxActions(),
  };
}
