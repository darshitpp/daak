import {
  createEngine,
  notifyReceived,
  relocateReceivedFiles,
  routeInboxEntry,
  syncShortcutTargets,
} from '@daak/platform';
import type { DaakEngine, DaakEvent, InboxEntry } from '@daak/core';
import { startEngine } from '../bootstrap';

jest.mock('@daak/platform', () => {
  const { fakeEngine } = jest.requireActual('@daak/ui');
  // bootstrap builds `engine` ONCE at import time via createEngine(), so this
  // test needs the handle on that one instance, not a fresh fakeEngine() per
  // call. The singleton lives on globalThis because jest hoists this factory
  // above the module body, so a module-level const here would be in TDZ.
  const g = globalThis as unknown as { __daakSingleton: DaakEngine | null };
  return {
    createEngine: () => {
      g.__daakSingleton ??= fakeEngine();
      return g.__daakSingleton;
    },
    consumePendingShare: jest.fn(),
    consumeIntentSends: jest.fn(async () => []),
    syncShortcutTargets: jest.fn(async () => {}),
    // startEngine now calls initNotifications (Task 8), so this mock has to
    // answer it or the subscription tests die on an undefined function.
    initNotifications: jest.fn(async () => true),
    // Task 10: startEngine also books the first background slot.
    initBackgroundSync: jest.fn(async () => {}),
    notifyReceived: jest.fn(async () => {}),
    routeInboxEntry: jest.fn(async () => {}),
    // R42p: the move runs on the same inbox.received branch. Undefined here
    // would throw before the router under test ever ran.
    relocateReceivedFiles: jest.fn(async () => undefined),
    realReceiveDeps: { clipboard: { setString: jest.fn(async () => true) } },
  };
});

let live = 0;
const teardowns: jest.Mock[] = [];

beforeAll(() => {
  // createEngine() returns the same instance bootstrap captured.
  const engine = createEngine();
  const realOn = engine.on.bind(engine);
  jest.spyOn(engine, 'on').mockImplementation((cb) => {
    live += 1;
    const off = realOn(cb);
    const teardown = jest.fn(() => {
      live -= 1;
      off();
    });
    teardowns.push(teardown);
    return teardown;
  });
});

describe('startEngine pairing.done subscription', () => {
  // A comment claiming "startEngine is called once" is not an invariant. If it
  // is ever called twice (a remount, a hot reload, a future owner), the second
  // call must drop the first subscription, or every pairing.done after that
  // fires its publish twice.
  it('does not leave two live subscriptions after being called twice', async () => {
    await startEngine();
    expect(live).toBe(1);

    await startEngine();
    expect(teardowns[0]).toHaveBeenCalledTimes(1);
    expect(live).toBe(1);

    await startEngine();
    expect(teardowns[1]).toHaveBeenCalledTimes(1);
    expect(live).toBe(1);
  });

  it('still publishes the peer list on every start (the point of the call)', async () => {
    const sync = jest.mocked(syncShortcutTargets);
    sync.mockClear();
    await startEngine();
    expect(sync).toHaveBeenCalled();
  });

  // R42: the inbox route is reached from the SAME subscription, next to
  // notifyReceived. A second engine.on would double-post a banner per receive
  // AND break the invariant the tests above pin, so this drives the ONE handler
  // that survived teardown.
  it('routes and notifies from the one subscription on one inbox event', async () => {
    const engine = createEngine();
    const handlers = (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers;
    const routed = jest.mocked(routeInboxEntry);
    const notified = jest.mocked(notifyReceived);
    routed.mockClear();
    notified.mockClear();

    const entry: InboxEntry = {
      payloadId: 'p1',
      transferId: 't1',
      peerDeviceId: 'd1',
      kind: 'text',
      itemCount: 1,
      summary: 'hi',
      receivedAt: 1,
      savedPaths: null,
    };
    for (const handler of handlers) handler({ type: 'inbox.received', payload: entry });
    // The handler fires two async routes without awaiting them, so let the
    // microtask queue drain before asserting on either call.
    await Promise.resolve();
    await Promise.resolve();

    expect(handlers.size).toBe(1);
    expect(routed).toHaveBeenCalledTimes(1);
    // The deps are the second arg, so this also pins that the real clipboard
    // is what the app hands it and not a bare import inside receive.ts.
    expect(routed).toHaveBeenCalledWith(entry, expect.objectContaining({ clipboard: expect.anything() }));
    expect(notified).toHaveBeenCalledTimes(1);
    expect(notified).toHaveBeenCalledWith(entry);
  });

  // The banner is a SNAPSHOT: its payload JSON is baked into the notification's
  // extras at post time. Posting BEFORE the download-folder move baked in paths
  // that the move then DELETED, so the banner's Share built a URI for a file
  // that was gone and the sheet opened with nothing attached.
  it('posts the banner with the locations the move produced', async () => {
    const engine = createEngine();
    const handlers = (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers;
    const moved = jest.mocked(relocateReceivedFiles);
    const notified = jest.mocked(notifyReceived);
    moved.mockClear();
    notified.mockClear();
    moved.mockResolvedValueOnce(['content://tree/new.jpg']);

    const entry: InboxEntry = {
      payloadId: 'p2',
      transferId: 't2',
      peerDeviceId: 'd1',
      kind: 'media',
      itemCount: 1,
      summary: 'photo.jpg',
      receivedAt: 1,
      savedPaths: ['/app/downloads/photo.jpg'],
    };
    for (const handler of handlers) handler({ type: 'inbox.received', payload: entry });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(moved).toHaveBeenCalledWith(engine, entry);
    expect(notified).toHaveBeenCalledWith({
      ...entry,
      savedPaths: ['content://tree/new.jpg'],
    });
    // The move must run BEFORE the post, or the banner snapshots a path the
    // move is about to delete.
    expect(moved.mock.invocationCallOrder[0]).toBeLessThan(notified.mock.invocationCallOrder[0]);
  });
});
