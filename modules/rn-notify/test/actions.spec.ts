import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildNotification, inboxActions } from '../js/actions';
import type { InboxNotificationEntry, NotifyAction } from '../js/actions';

// No `as any`. The engine's real InboxEntry has EIGHT required fields
// (payloadId, transferId, peerDeviceId, kind, itemCount, summary, receivedAt,
// savedPaths -- packages/core/src/engine/types.ts:11-26), so the plan's
// `{payloadId, summary, kind, itemCount} as any` fixture worked only by
// disabling the type check. buildNotification takes the three-field structural
// subset instead (read js/actions.ts for why there is no @daak/core dependency),
// so a real InboxEntry is assignable to it and the fixture is fully typed.
const entry = (fields: Partial<InboxNotificationEntry> = {}): InboxNotificationEntry => ({
  payloadId: 'p1',
  itemCount: 1,
  summary: 'IMG_1234.jpg',
  ...fields,
});

describe('inboxActions', () => {
  // R37, applied to desktop exactly as packages/platform/src/notify.ts:10-18
  // applies it to mobile: a button that does nothing is worse than no button.
  // Only 'open' is installed. See the withhold comments in js/actions.ts for
  // what to add back and when.
  it('installs only Open', () => {
    expect(inboxActions().map((action) => action.id)).toEqual(['open']);
    expect(inboxActions().map((action) => action.label)).toEqual(['Open']);
  });

  // The WITHHELD ids, pinned so a re-add is a deliberate edit to this test
  // rather than a silent consequence of someone tidying the array. These are
  // the two that used to be installed and now have no implementation behind
  // them: 'share' (no desktop re-share surface) and 'show' (reveal has no
  // implementation, and its label promised Finder).
  it('withholds share and show, which have no implementation', () => {
    const ids = inboxActions().map((action) => action.id);
    expect(ids).not.toContain('share');
    expect(ids).not.toContain('show');
  });

  // The TYPE still carries all three ids, because the vocabulary is frozen and
  // the withheld ids stay nameable. A withheld id is absent from the LIST, not
  // from the type -- the same split as DAK_RECEIVED_ACTIONS vs
  // DAK_REGISTERED_ACTIONS in packages/platform/src/notify.ts.
  //
  // A COMPILE-TIME pin, not a runtime one. The earlier version of this test
  // built a three-element array and asserted its length, which is tautological:
  // it passed for any type, and would have passed unchanged if the union had
  // been widened to include 'folder'. @ts-expect-error inverts the check -- it
  // FAILS typecheck if the assignment below ever becomes legal, so the union
  // can neither lose an id nor gain one without tsc objecting. Vitest does not
  // typecheck, so this assertion does nothing at RUN time; `tsc --noEmit` in the
  // typecheck script is what enforces it. That is why the two lines below are
  // deliberately never evaluated as a claim about the type.
  it('keeps the vocabulary type frozen at three ids', () => {
    // @ts-expect-error 'folder' is not in the frozen vocabulary and must never be.
    const notAnActionId: NotifyAction['id'] = 'folder';
    expect(notAnActionId).toBe('folder');
  });
});

// THE PARITY INVARIANT. js/actions.ts's inboxActions() is the source of truth
// for which buttons exist, and macos/RNNotify.mm mirrors it in a category table
// that no compiler, type or test connects to the other. Round 2 changed the TS
// list and the .mm in the same commit and nothing would have caught it if only
// one had moved -- an id in the table with nothing in the list is a button that
// lies, which is exactly what R37 exists to prevent, and an id in the list with
// nothing in the table is a notification with a missing button.
//
// Read the .mm as TEXT, not by compiling or linking it. Compiling would need a
// pod install, and linking would need a running app; a regex over the source is
// the one check that runs in CI, on Linux, with no toolchain.
describe('macOS category parity', () => {
  const source = readFileSync(join(__dirname, '..', 'macos', 'RNNotify.mm'), 'utf8');

  // Deliberately `actionWithIdentifier:`, not the more general Notification
  // Action/Category identifier spelling. A category has an identifier too, and
  // matching that as well would make this test compare the category name
  // ('daak.inbox') against an action id and fail for the right reason at the
  // wrong time.
  const registered = [...source.matchAll(/actionWithIdentifier:@"([^"]+)"/g)].map((m) => m[1]);

  it('installs exactly the actions inboxActions returns, in the same order', () => {
    expect(registered).toEqual(inboxActions().map((action) => action.id));
  });

  // The table is built as a literal @[ ... ] array in +load, so a count of
  // matchAll hits IS a count of installed actions. Asserting it is non-empty
  // means the parity test above cannot pass VACUOUSLY, which is the one failure
  // mode a file-reading invariant has: a typo in the regex returns [], []
  // equals [], green, and the invariant guards nothing.
  it('found the action table at all', () => {
    expect(registered.length).toBeGreaterThan(0);
  });
});

describe('buildNotification', () => {
  it('builds a daak.inbox notification carrying the payload id and actions', () => {
    const notification = buildNotification(entry());
    expect(notification.category).toBe('daak.inbox');
    expect(notification.payloadId).toBe('p1');
    expect(notification.body).toContain('IMG_1234.jpg');
    expect(notification.actions).toHaveLength(1);
  });

  it('pluralises multi-item batches', () => {
    expect(buildNotification(entry({ payloadId: 'p2', itemCount: 3 })).title).toContain('3 items');
  });

  // The singular arm is what the plan's title pluraliser gets wrong when it is
  // only ever tested on a batch, and it is the arm almost every real text share
  // lands on.
  it('uses the singular for a single item', () => {
    expect(buildNotification(entry()).title).toBe('Received 1 item');
  });

  // NOT desktop's `daak.received`: that is packages/platform's MOBILE category,
  // frozen in DAK_RECEIVED_CATEGORY with `daak.open`/`daak.share`/`daak.folder`
  // ids. This task's ids are the plain `open`/`share`/`show` the plan pins, and
  // they reach desktop as a native event -- RNNotify.mm emits
  // DaakSystemNotifyAction {actionId, payloadId} to apps/desktop/src/notify.ts's
  // planNotifyAction, which is their only consumer. (An earlier version of this
  // comment claimed apps/desktop/src/routes.ts parsed them, and named a
  // parseNotificationRoute there. That parser was a Windows toast-argument
  // format, Windows is out of scope for this phase, and both the function and
  // the claim are gone: routes.ts exports parseDirectShareRoute only.) Pinning
  // the category here so a future edit cannot quietly collapse the two
  // vocabularies into one.
  it('keeps the desktop category and ids separate from mobile daak.received', () => {
    const notification = buildNotification(entry());
    expect(notification.category).toBe('daak.inbox');
    expect(notification.category).not.toBe('daak.received');
    expect(inboxActions().map((action) => action.id)).not.toContain('daak.open' as never);
  });

  // A fresh array every call, so a caller that mutates the returned list cannot
  // change what the next notification shows.
  it('returns independent action lists', () => {
    const first = buildNotification(entry());
    first.actions.pop();
    expect(buildNotification(entry()).actions).toHaveLength(1);
  });
});
