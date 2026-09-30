import { describe, expect, it } from 'vitest';
import { planNotifyAction, applyNotifyAction, notifyInboxEntry } from '../src/notify';
import type { NotifyEngine, NotifyHost } from '../src/notify';
import type { DaakEvent, InboxEntry } from '@daak/core/src/engine/types';

// The host records instead of doing. Nothing here touches AppKit, NativeModules
// or the DaakSystemNotify TurboModule: the decision (planNotifyAction) is a pure
// function and the effects are behind NotifyHost, which is the split
// src/tray-action.ts already uses for the same reason -- it is what lets this
// suite run under plain vitest with no RN import in the module under test.
function recorder() {
  const calls: string[] = [];
  const host: NotifyHost = {
    openDashboard() {
      calls.push('open-dashboard');
    },
  };
  return { calls, host };
}

// A REAL InboxEntry, all eight fields, no cast. InboxEntry has no optional
// field (packages/core/src/engine/types.ts:11-26), so a partial fixture would
// need an `as any` to compile -- which is how the plan's own tests ended up
// hiding engine fields from the type checker.
function entry(fields: Partial<InboxEntry> = {}): InboxEntry {
  return {
    payloadId: 'p1',
    transferId: 't1',
    peerDeviceId: '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
    kind: 'media',
    itemCount: 1,
    summary: 'a.txt',
    receivedAt: 1_700_000_000_000,
    savedPaths: ['/tmp/daak/a.txt'],
    ...fields,
  };
}

describe('planNotifyAction', () => {
  it('maps open to the dashboard', () => {
    expect(planNotifyAction('open')).toBe('open-dashboard');
  });

  // R37 on desktop: 'share' and 'show' are WITHHELD at the native layer (see
  // modules/rn-notify/js/actions.ts inboxActions), so the centre cannot deliver
  // them. A withheld id reaching the planner anyway is a malformed event and is
  // dropped, NOT quietly aliased onto open -- opening the dashboard for a
  // payload the user did not ask to open is the wrong thing to do.
  it('drops the withheld ids rather than aliasing them onto open', () => {
    expect(planNotifyAction('share')).toBeNull();
    expect(planNotifyAction('show')).toBeNull();
  });

  // An unknown id is not silently treated as 'open'. The three ids are the
  // frozen vocabulary -- the union NotifyAction['id'] -- and only 'open' is
  // INSTALLED: macos/RNNotify.mm's daak.inbox category carries one action, the
  // one inboxActions() returns, and modules/rn-notify/test/actions.spec.ts pins
  // that parity. So an id outside the vocabulary is a malformed event, and so is
  // a withheld one; opening the dashboard for a payload the user did not name
  // is the wrong thing to do with either.
  it('rejects an id outside the frozen vocabulary', () => {
    expect(planNotifyAction('delete' as never)).toBeNull();
    expect(planNotifyAction('' as never)).toBeNull();
  });
});

describe('applyNotifyAction', () => {
  it('opens the dashboard for open', () => {
    const { calls, host } = recorder();
    applyNotifyAction('open', host);
    expect(calls).toEqual(['open-dashboard']);
  });

  // No host effect at all for anything that is not 'open'. The NotifyHost has no
  // sharePayload member any more, so there is nothing for a withheld id to
  // call: the withheld buttons are gone at the source (inboxActions) and the
  // planner agrees, so there is no empty handler left to lie.
  it('does nothing at all for the withheld ids', () => {
    const { calls, host } = recorder();
    applyNotifyAction('share', host);
    applyNotifyAction('show', host);
    expect(calls).toEqual([]);
  });

  it('does nothing at all for an id outside the vocabulary', () => {
    const { calls, host } = recorder();
    applyNotifyAction('delete' as never, host);
    expect(calls).toEqual([]);
  });
});

describe('notifyInboxEntry', () => {
  // A received payload posts a banner and nothing else: the inbox stays the
  // source of truth. The fake engine proves the only event this consumes is
  // inbox.received, so a device.discovered or a transfer.progress cannot post a
  // notification. No assertion on the banner text here -- that is
  // modules/rn-notify/test/actions.spec.ts, which owns buildNotification.
  it('posts exactly once per inbox.received event', async () => {
    const posted: InboxEntry[] = [];
    let handler: ((e: DaakEvent) => void) | undefined;
    const engine: NotifyEngine = {
      on(cb) {
        handler = cb;
        return () => {};
      },
    };
    const deps = { post: (entry: InboxEntry) => { posted.push(entry); return Promise.resolve(); } };

    const stop = notifyInboxEntry(engine, deps);
    // A real DeviceInfo, because the whole point of this event is that
    // notifyInboxEntry must ignore it. If the union field were misspelled the
    // compiler would reject the fixture rather than silently passing.
    handler?.({
      type: 'device.discovered',
      device: { deviceId: 'd1', name: 'peer', addr: '10.0.0.2' },
    });
    handler?.({ type: 'inbox.received', payload: entry({ payloadId: 'p1', itemCount: 1 }) });
    handler?.({ type: 'inbox.received', payload: entry({ payloadId: 'p2', itemCount: 2 }) });
    // deps.post is called through a resolved-promise chain so a THROW inside it
    // cannot escape the engine callback; that also defers the call by a
    // microtask, so flush before asserting.
    await Promise.resolve();
    await Promise.resolve();

    expect(posted).toHaveLength(2);
    expect(posted.map((e) => e.payloadId)).toEqual(['p1', 'p2']);
    expect(typeof stop).toBe('function');
  });

  // A rejected post must not take down the ONE engine subscription that also
  // carries pairing and transfer events (apps/mobile/src/bootstrap.ts:100 is the
  // same reasoning). Swallowed, with the dashboard still alive.
  it('survives a post that rejects', async () => {
    let handler: ((e: DaakEvent) => void) | undefined;
    const engine: NotifyEngine = {
      on(cb) {
        handler = cb;
        return () => {};
      },
    };
    const deps = { post: () => Promise.reject(new Error('no centre')) };
    notifyInboxEntry(engine, deps);
    expect(() =>
      handler?.({ type: 'inbox.received', payload: entry() }),
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});
