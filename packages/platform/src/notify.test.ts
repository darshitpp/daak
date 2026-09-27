import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@daak/rn-notify', () => ({
  default: {
    requestPermission: vi.fn(async () => true),
    registerCategories: vi.fn(async () => {}),
    post: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    consumePendingAction: vi.fn(async () => ''),
    addListener: vi.fn(),
    removeListeners: vi.fn(),
  },
}));

import NativeDaakNotify from '@daak/rn-notify';
import type { InboxEntry } from '@daak/core';
import {
  DAK_REGISTERED_ACTIONS,
  DAK_RECEIVED_ACTIONS,
  DAK_RECEIVED_CATEGORY,
  handleNotificationAction,
  initNotifications,
  notifyReceived,
  onNotificationAction,
} from './notify';

const native = vi.mocked(NativeDaakNotify);

const entry: InboxEntry = {
  payloadId: 'p1',
  transferId: 't1',
  peerDeviceId: 'd1',
  kind: 'media',
  itemCount: 2,
  summary: 'movie.mov + 1 more',
  receivedAt: 1,
  savedPaths: ['/tmp/movie.mov'],
};

beforeEach(() => {
  vi.clearAllMocks();
  native.requestPermission.mockResolvedValue(true);
  native.registerCategories.mockResolvedValue(undefined);
  native.post.mockResolvedValue(undefined);
  native.consumePendingAction.mockResolvedValue('');
});

describe('notifyReceived', () => {
  it('posts under the received category with a JSON payload', async () => {
    await notifyReceived(entry);
    expect(native.post).toHaveBeenCalledWith(
      'p1',
      'Daak',
      'movie.mov + 1 more',
      DAK_RECEIVED_CATEGORY,
      JSON.stringify(entry),
    );
  });
});

describe('initNotifications', () => {
  it('registers the received category with its registered action ids', async () => {
    await initNotifications();
    expect(native.registerCategories).toHaveBeenCalledWith(
      JSON.stringify([{ id: DAK_RECEIVED_CATEGORY, actions: DAK_REGISTERED_ACTIONS }]),
    );
  });

  it('reports the runtime-permission answer', async () => {
    native.requestPermission.mockResolvedValue(false);
    await expect(initNotifications()).resolves.toBe(false);
  });

  // R36: on API 33+ POST_NOTIFICATIONS is a RUNTIME permission, so `false` is
  // an ordinary answer, not an error. The categories still have to be
  // registered so a later grant works, and nothing here may throw: a denied
  // permission that took down startup would take the receive path with it.
  it('still registers categories when permission is denied (R36)', async () => {
    native.requestPermission.mockResolvedValue(false);
    await expect(initNotifications()).resolves.toBe(false);
    expect(native.registerCategories).toHaveBeenCalledTimes(1);
  });

  // A module that cannot ask at all (no foreground activity) rejects rather
  // than answering. That is not a startup crash either.
  it('does not throw when the permission request itself rejects', async () => {
    native.requestPermission.mockRejectedValue(new Error('E_NO_ACTIVITY'));
    await expect(initNotifications()).resolves.toBe(false);
  });

  // R36 applies to registration, not just the permission: a category install
  // that rejects must not reject startEngine, or app startup dies on a
  // notification detail and takes the receive path with it.
  it('does not throw when registerCategories rejects', async () => {
    native.registerCategories.mockRejectedValue(new Error('E_NOTIFY'));
    await expect(initNotifications()).resolves.toBe(true);
    await expect(native.registerCategories.mock.results[0].value).rejects.toThrow('E_NOTIFY');
  });

  // R37: the INSTALLED category omits daak.folder (reveal is unimplemented on
  // both platforms) while the frozen id vocabulary keeps it.
  it('registers only the actions that have a working handler (R37)', async () => {
    await initNotifications();
    expect(native.registerCategories).toHaveBeenCalledWith(
      JSON.stringify([{ id: DAK_RECEIVED_CATEGORY, actions: DAK_REGISTERED_ACTIONS }]),
    );
    expect(DAK_REGISTERED_ACTIONS).toEqual(['daak.open', 'daak.share']);
    expect(DAK_RECEIVED_ACTIONS).toContain('daak.folder');
  });
});

// R36 from the other end: with the permission denied the native post is a
// no-op or a rejection. The inbox is the source of truth, so a failed post is
// an observable drop, never a throw back into the engine's event handler.
describe('notifyReceived with no notification permission (R36)', () => {
  it('does not throw and reports the dropped notification', async () => {
    native.post.mockRejectedValue(new Error('permission denied'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(notifyReceived(entry)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('p1'));
    } finally {
      warn.mockRestore();
    }
  });
});

// R33. The share action must be the SAME OS share sheet every other share goes
// through. The handler gets exactly one capability injection point, so a second
// send path (its own transport, its own crypto) has nowhere to live: the only
// thing it can do is call `present`.
describe('handleNotificationAction', () => {
  const handlers = () => ({ present: vi.fn(async () => {}), reveal: vi.fn(), open: vi.fn() });

  it('routes daak.share through the share sheet with the saved paths', () => {
    const h = handlers();
    handleNotificationAction({ action: 'daak.share', payload: JSON.stringify(entry) }, h);
    expect(h.present).toHaveBeenCalledWith({ urls: ['/tmp/movie.mov'] });
    expect(h.reveal).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled();
  });

  it('shares nothing rather than guessing when the payload has no files', () => {
    const h = handlers();
    handleNotificationAction(
      { action: 'daak.share', payload: JSON.stringify({ ...entry, savedPaths: null }) },
      h,
    );
    expect(h.present).not.toHaveBeenCalled();
  });

  it('reveals the first saved path for daak.folder and nothing else', () => {
    const h = handlers();
    handleNotificationAction({ action: 'daak.folder', payload: JSON.stringify(entry) }, h);
    expect(h.reveal).toHaveBeenCalledWith('/tmp/movie.mov');
    expect(h.present).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled();
  });

  it('does not reveal an empty path for an entry that saved no files', () => {
    const h = handlers();
    handleNotificationAction({ action: 'daak.folder', payload: '{}' }, h);
    expect(h.reveal).not.toHaveBeenCalled();
  });

  it('hands the raw payload to the opener for daak.open', () => {
    const h = handlers();
    const payload = JSON.stringify(entry);
    handleNotificationAction({ action: 'daak.open', payload }, h);
    expect(h.open).toHaveBeenCalledWith(payload);
    expect(h.present).not.toHaveBeenCalled();
  });

  // A payload written by an older build, or truncated, is still just a string.
  // Throwing here would break the emitter's dispatch for every later action.
  it('survives an unparseable payload', () => {
    const h = handlers();
    expect(() =>
      handleNotificationAction({ action: 'daak.share', payload: 'not json' }, h),
    ).not.toThrow();
    expect(h.present).not.toHaveBeenCalled();
  });
});

describe('onNotificationAction', () => {
  it('drains an action the native side stashed while JS was dead', async () => {
    native.consumePendingAction.mockResolvedValue(
      JSON.stringify({ action: 'daak.share', payload: JSON.stringify(entry) }),
    );
    const seen: { action: string; payload: string }[] = [];
    onNotificationAction((e) => seen.push(e));
    // Deterministic: the stash arrives over a promise, so wait for the value
    // rather than counting microtask ticks.
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(native.consumePendingAction).toHaveBeenCalled();
    expect(seen).toEqual([{ action: 'daak.share', payload: JSON.stringify(entry) }]);
  });

  // A daak.folder event can still arrive (a build that registered it, a cold
  // stash from one). Withholding the button must not make the handler throw.
  it('tolerates a withheld daak.folder event', () => {
    const h = { present: vi.fn(async () => {}), reveal: vi.fn(), open: vi.fn() };
    expect(() =>
      handleNotificationAction(
        { action: 'daak.folder', payload: JSON.stringify(entry) },
        h,
      ),
    ).not.toThrow();
  });
});
