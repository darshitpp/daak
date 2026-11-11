import {
  createEngine,
  notifyFailedSend,
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
    // Task 12: the failed-send banner and the save folder name of a mixed folder.
    notifyFailedSend: jest.fn(async () => {}),
    downloadFolderName: jest.fn(async () => 'Downloads'),
    startTransferForeground: jest.fn(async () => {}),
    stopTransferForeground: jest.fn(async () => {}),
    routeInboxEntry: jest.fn(async () => {}),
    // R42p: the move runs on the same inbox.received branch. Undefined here
    // would throw before the router under test ever ran.
    relocateReceivedFiles: jest.fn(async () => undefined),
    realReceiveDeps: { clipboard: { setString: jest.fn(async () => true) } },
    createBatchDriver: jest.fn(() => ({ start: jest.fn(), onEvent: jest.fn(), retry: jest.fn(), stop: jest.fn(), status: jest.fn(() => null), resume: jest.fn(async () => {}), dispose: jest.fn() })),
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

  // A revoked peer must leave the share sheet at once, not at the next launch.
  // Discovery lists peers the engine refuses to send to, so only paired devices
  // become shortcuts.
  it('republishes only paired devices when a pairing is revoked', async () => {
    const engine = createEngine();
    const handlers = (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers;
    await startEngine();
    const sync = jest.mocked(syncShortcutTargets);
    sync.mockClear();
    jest.spyOn(engine, 'devices').mockResolvedValue([
      { deviceId: 'aa'.repeat(16), name: 'Paired', online: true, paired: true },
      { deviceId: 'bb'.repeat(16), name: 'Seen only', online: true, paired: false },
    ] as Awaited<ReturnType<typeof engine.devices>>);

    for (const handler of handlers) handler({ type: 'pairing.revoked', deviceId: 'cc'.repeat(16) });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0][0].map((d) => d.deviceId)).toEqual(['aa'.repeat(16)]);
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
    // A text entry has no folder, so the host gives no folder text.
    expect(notified).toHaveBeenCalledWith(entry, null);
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

    // An entry from an old engine has no groupRoots: the files are loose.
    expect(moved).toHaveBeenCalledWith(engine, { ...entry, groupRoots: [] });
    expect(notified).toHaveBeenCalledWith(
      {
        ...entry,
        savedPaths: ['content://tree/new.jpg'],
      },
      null,
    );
    // The move must run BEFORE the post, or the banner snapshots a path the
    // move is about to delete.
    expect(moved.mock.invocationCallOrder[0]).toBeLessThan(notified.mock.invocationCallOrder[0]);
  });

  // Task 10: the folder roots come from the event entry, from before the move.
  it('passes the folder roots of the event entry to the move', async () => {
    const engine = createEngine();
    const handlers = (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers;
    const moved = jest.mocked(relocateReceivedFiles);
    moved.mockClear();
    const entry: InboxEntry = {
      payloadId: 'p3',
      transferId: 't3',
      peerDeviceId: 'd1',
      kind: 'batch',
      itemCount: 1,
      summary: 'album',
      receivedAt: 1,
      savedPaths: ['/app/downloads/album/a.jpg'],
      groupRoots: ['/app/downloads/album'],
    };
    for (const handler of handlers) handler({ type: 'inbox.received', payload: entry });
    await Promise.resolve();
    await Promise.resolve();

    expect(moved).toHaveBeenCalledWith(engine, entry);
  });

  // Task 12. The name and the count come from the event entry, from before the
  // move. The places line comes from the paths after the move. Jest runs as iOS,
  // so the library is Photos and the save folder is Daak.
  it('a_mixed_folder_names_the_places_after_the_move', async () => {
    const engine = createEngine();
    const handlers = (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers;
    const moved = jest.mocked(relocateReceivedFiles);
    const notified = jest.mocked(notifyReceived);
    moved.mockClear();
    notified.mockClear();
    const after = ['photos:ID1', '/Daak/album/b.pdf', 'photos:ID2'];
    moved.mockResolvedValueOnce(after);
    const entry: InboxEntry = {
      payloadId: 'p4',
      transferId: 't4',
      peerDeviceId: 'd1',
      kind: 'batch',
      itemCount: 3,
      summary: '3 files',
      receivedAt: 1,
      savedPaths: ['/app/downloads/album/a.jpg', '/app/downloads/album/b.pdf', '/app/downloads/album/sub/c.mov'],
      groupRoots: ['/app/downloads/album'],
    };
    for (const handler of handlers) handler({ type: 'inbox.received', payload: entry });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    expect(notified).toHaveBeenCalledWith(
      { ...entry, savedPaths: after },
      { title: 'Received a folder', body: 'album · 3 files\nPhotos and videos: Photos. Other files: Daak.' },
    );
    expect(moved.mock.invocationCallOrder[0]).toBeLessThan(notified.mock.invocationCallOrder[0]);
  });
});

describe('startEngine failed-send notification', () => {
  const PEER = 'aa'.repeat(16);
  const settle = async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };
  const setup = async (transferId: string, direction: 'in' | 'out' = 'out') => {
    const engine = createEngine();
    const handlers = (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers;
    await startEngine();
    const list = jest.spyOn(engine, 'listTransfers').mockResolvedValue([
      {
        transferId,
        peerDeviceId: PEER,
        direction,
        kind: 'batch',
        state: 'failed',
        bytesDone: 0,
        bytesTotal: 10,
        itemCount: 2,
        updatedAt: 1,
      },
    ]);
    jest.spyOn(engine, 'listThread').mockResolvedValue({
      items: ['a.jpg', 'b.jpg'].map((name, i) => ({
        transferId,
        itemIndex: i,
        direction,
        type: 'file' as const,
        name,
        size: 5,
        text: null,
        state: 'failed' as const,
        destPath: null,
        at: 1,
        transferState: 'failed',
        error: null,
        group: { name: 'album', rel: name, files: 2, bytes: 10 },
      })),
      olderCursor: null,
    });
    // The engine is one shared instance, so a spy keeps the calls of an earlier test.
    list.mockClear();
    const posted = jest.mocked(notifyFailedSend);
    posted.mockClear();
    const fire = (e: DaakEvent) => {
      for (const handler of handlers) handler(e);
    };
    return { list, posted, fire };
  };

  it('posts the folder name for a failed folder send, from the one subscription', async () => {
    const tid = '51'.repeat(16);
    const { posted, fire } = await setup(tid);
    fire({ type: 'transfer.failed', transferId: tid, error: 'gone' });
    await settle();
    expect(posted).toHaveBeenCalledTimes(1);
    expect(posted).toHaveBeenCalledWith({
      transferId: tid,
      peerDeviceId: PEER,
      updatedAt: 1,
      title: "Couldn't send album",
      body: 'Open Daak to try again.',
    });
  });

  it('a_failed_send_posts_once_even_when_the_event_repeats', async () => {
    const tid = '52'.repeat(16);
    const { posted, fire } = await setup(tid);
    fire({ type: 'transfer.failed', transferId: tid, error: 'gone' });
    fire({ type: 'transfer.failed', transferId: tid, error: 'gone' });
    await settle();
    fire({ type: 'transfer.failed', transferId: tid, error: 'gone' });
    await settle();
    expect(posted).toHaveBeenCalledTimes(1);
  });

  // Fix round 1: Engine::retry keeps the transfer id. A retry that fails again
  // is a new failure with a new updatedAt, so it posts a second banner.
  it('a_retried_send_that_fails_again_posts_again', async () => {
    const tid = '55'.repeat(16);
    const { list, posted, fire } = await setup(tid);
    fire({ type: 'transfer.failed', transferId: tid, error: 'gone' });
    await settle();
    const [first] = await createEngine().listTransfers();
    list.mockResolvedValue([{ ...first, updatedAt: 2 }]);
    fire({ type: 'transfer.failed', transferId: tid, error: 'gone' });
    await settle();
    expect(posted).toHaveBeenCalledTimes(2);
  });

  // A retry back-off sends no transfer.failed. It sends a queue count and
  // progress, and neither may post a failed-send banner.
  it('a_retry_back_off_posts_nothing', async () => {
    const tid = '53'.repeat(16);
    const { list, posted, fire } = await setup(tid);
    fire({ type: 'outbox.queued', deviceId: PEER, queued: 1 });
    fire({ type: 'transfer.progress', transferId: tid, bytesDone: 0, bytesTotal: 10 });
    fire({ type: 'transfer.item', transferId: tid, itemIndex: 0, state: 'failed' });
    await settle();
    expect(posted).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('posts nothing for the all-zero id of an inbound failure', async () => {
    const { list, posted, fire } = await setup('0'.repeat(32));
    fire({ type: 'transfer.failed', transferId: '0'.repeat(32), error: 'bad frame' });
    await settle();
    expect(posted).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('posts nothing for a failed inbound transfer row', async () => {
    const tid = '54'.repeat(16);
    const { posted, fire } = await setup(tid, 'in');
    fire({ type: 'transfer.failed', transferId: tid, error: 'gone' });
    await settle();
    expect(posted).not.toHaveBeenCalled();
  });
});

// The batch folding lives in shareNotifier and is called from the one handler.
// A second engine.on would post a banner twice for each receive.
describe('startEngine batched share subscription', () => {
  it('keeps exactly one engine.on after a tagged inbox event', async () => {
    const engine = createEngine();
    const handlers = (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers;
    await startEngine();
    expect(live).toBe(1);
    const entry: InboxEntry = {
      payloadId: 'p9',
      transferId: 't9',
      peerDeviceId: 'd9',
      kind: 'media',
      itemCount: 1,
      summary: 'a.jpg',
      receivedAt: 1,
      savedPaths: ['/tmp/a.jpg'],
      share: 'ab'.repeat(16),
      batch: '1/2',
    };
    for (const handler of handlers) handler({ type: 'inbox.received', payload: entry });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(live).toBe(1);
    expect(handlers.size).toBe(1);
    expect(jest.mocked(notifyReceived).mock.calls.some((c) => c[2]?.silent === true)).toBe(true);
  });
});
