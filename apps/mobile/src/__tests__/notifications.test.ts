import type { DaakEngine, InboxEntry } from '@daak/core';
import { presentShare } from '@daak/platform';

import { startEngine, wireNotificationActions } from '../bootstrap';

// @daak/rn-notify only reaches this file through the real notify.ts below, and
// getEnforcing throws under Jest. Nothing calls it: onNotificationAction is
// mocked, so the real file is loaded for exactly one exported function.
jest.mock('@daak/rn-notify', () => ({ default: {} }));

// handleNotificationAction is taken from the REAL platform file: it is the R33
// guard, and a test that mocks the very function it exists to police is worth
// nothing. The relative path is needed because jest.requireActual on
// @daak/platform loads the barrel, which reaches @daak/core -> cbor-x (ESM).
// handleNotificationAction touches no native module, so the file loads fine.
type NotifyModule = typeof import('../../../../packages/platform/src/notify');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const notifyModule: NotifyModule = require('../../../../packages/platform/src/notify');

jest.mock('@daak/platform', () => {
  const real = jest.requireActual('../../../../packages/platform/src/notify') as NotifyModule;
  return {
    createEngine: () => require('@daak/ui').fakeEngine(),
    consumePendingShare: jest.fn(async () => []),
    consumeIntentSends: jest.fn(async () => []),
    syncShortcutTargets: jest.fn(async () => {}),
    presentShare: jest.fn(async () => {}),
    initNotifications: jest.fn(async () => true),
    // Task 10: startEngine also books the first background slot. Absent from
    // this mock the suite dies on an undefined function, not on a behaviour.
    initBackgroundSync: jest.fn(async () => {}),
    notifyReceived: jest.fn(async () => {}),
    // R42: the inbox route is reached from the SAME subscription as
    // notifyReceived, so this mock has to answer it or the handler dies.
    routeInboxEntry: jest.fn(async () => {}),
    realReceiveDeps: { clipboard: { setString: jest.fn(async () => true) } },
    onNotificationAction: jest.fn(() => () => {}),
    handleNotificationAction: real.handleNotificationAction,
  };
});

const platform = jest.mocked(require('@daak/platform'));
const { engine } = require('../bootstrap') as { engine: DaakEngine };
const on = jest.spyOn(engine, 'on');

const entry: InboxEntry = {
  payloadId: 'p1',
  transferId: 't1',
  peerDeviceId: 'd1',
  kind: 'media',
  itemCount: 1,
  summary: 'movie.mov',
  receivedAt: 1,
  savedPaths: ['/tmp/movie.mov'],
};

/** The callback the module handed to onNotificationAction. */
function tapped(): (e: { action: string; payload: string }) => void {
  return platform.onNotificationAction.mock.calls[0][0];
}

beforeEach(() => jest.clearAllMocks());

describe('startEngine notifications', () => {
  it('asks for the notification permission on start', async () => {
    on.mockReturnValue(jest.fn());
    await startEngine();
    expect(platform.initNotifications).toHaveBeenCalledTimes(1);
  });

  it('posts a banner for every inbox.received event', async () => {
    on.mockReturnValue(jest.fn());
    await startEngine();
    on.mock.calls[0][0]({ type: 'inbox.received', payload: entry });
    expect(platform.notifyReceived).toHaveBeenCalledWith(entry);
  });

  it('ignores every other engine event', async () => {
    on.mockReturnValue(jest.fn());
    await startEngine();
    on.mock.calls[0][0]({ type: 'transfer.done', transferId: 't1' });
    expect(platform.notifyReceived).not.toHaveBeenCalled();
  });

  // R36: a denied permission is an ordinary answer. startEngine calls this, so a
  // throw here would take down app startup and with it the receive path.
  it('does not throw when the permission is denied (R36)', async () => {
    platform.initNotifications.mockResolvedValueOnce(false);
    on.mockReturnValue(jest.fn());
    await expect(startEngine()).resolves.toBeUndefined();
  });
});

// R33, at the one place the app binds the handler. presentShare is the app's
// EXISTING share-sheet binding, so a tapped daak.share is the same sheet every
// other share uses -- there is no second transport to regress into, because
// bootstrap imports none. handleNotificationAction's own behaviour is pinned in
// packages/platform/src/notify.test.ts.
describe('wireNotificationActions', () => {
  it('routes daak.share to presentShare, the one existing sheet binding', () => {
    wireNotificationActions(jest.fn(), jest.fn());
    tapped()({ action: 'daak.share', payload: JSON.stringify(entry) });
    expect(presentShare).toHaveBeenCalledWith({ urls: ['/tmp/movie.mov'] });
  });

  it('never touches the engine for any action', () => {
    const send = jest.spyOn(engine, 'send');
    const reveal = jest.fn();
    const open = jest.fn();
    wireNotificationActions(reveal, open);
    for (const action of ['daak.open', 'daak.share', 'daak.folder']) {
      tapped()({ action, payload: JSON.stringify(entry) });
    }
    // The outbox is the ONLY send path. If a notification action could enqueue
    // or send, this fails.
    expect(send).not.toHaveBeenCalled();
    expect(reveal).toHaveBeenCalledWith('/tmp/movie.mov');
    expect(open).toHaveBeenCalledWith(JSON.stringify(entry));
  });

  it('returns the unsubscribe from the subscription', () => {
    const off = jest.fn();
    platform.onNotificationAction.mockReturnValueOnce(off);
    expect(wireNotificationActions(jest.fn(), jest.fn())).toBe(off);
  });
});

describe('handleNotificationAction (the real one, through the app binding)', () => {
  it('does not open an empty sheet for an entry that saved no files', () => {
    const present = jest.fn(async () => {});
    const reveal = jest.fn();
    notifyModule.handleNotificationAction(
      { action: 'daak.share', payload: JSON.stringify({ ...entry, kind: 'text', savedPaths: [] }) },
      { present, reveal, open: jest.fn() },
    );
    expect(present).not.toHaveBeenCalled();
  });
});
