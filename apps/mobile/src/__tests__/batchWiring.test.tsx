import { startEngine } from '../bootstrap';
import { attachedMedia } from '../SendFlow';

// The batch driver is wired in bootstrap.ts: ONE driver, fed by the ONE
// engine.on handler, resumed after the startup sweep. @daak/platform is mocked,
// so the cbor-x ESM barrel never loads.
jest.mock('@daak/platform', () => {
  const g = globalThis as unknown as { __batchDriver?: unknown; __batchEngine?: unknown; __sweep?: { run: () => Promise<void> } };
  g.__sweep = { run: async () => {} };
  g.__batchDriver = {
    start: jest.fn(async () => ({ share: 'a'.repeat(32) })),
    onEvent: jest.fn(),
    retry: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
    release: jest.fn(async () => {}),
    status: jest.fn(() => null),
    resume: jest.fn(async () => {}),
    dispose: jest.fn(),
  };
  return {
    createEngine: () => {
      g.__batchEngine ??= jest.requireActual('@daak/ui').fakeEngine();
      return g.__batchEngine;
    },
    createBatchDriver: jest.fn((deps: unknown) => {
      (g as { __batchDeps?: unknown }).__batchDeps = deps;
      return g.__batchDriver;
    }),
    consumePendingShare: jest.fn(async () => []),
    consumeIntentSends: jest.fn(async () => []),
    syncShortcutTargets: jest.fn(async () => {}),
    initNotifications: jest.fn(async () => true),
    initBackgroundSync: jest.fn(async () => {}),
    notifyReceived: jest.fn(async () => {}),
    notifyFailedSend: jest.fn(async () => {}),
    startTransferForeground: jest.fn(async () => {}),
    stopTransferForeground: jest.fn(async () => {}),
    routeInboxEntry: jest.fn(async () => {}),
    relocateReceivedFiles: jest.fn(async () => undefined),
    realReceiveDeps: { clipboard: { setString: jest.fn(async () => true) } },
    downloadFolderName: jest.fn(async () => null),
    sweepPickedCopies: jest.fn(() => (globalThis as unknown as { __sweep: { run: () => Promise<void> } }).__sweep.run()),
    materializeMedia: jest.fn(async () => ''),
    discardPickedCopy: jest.fn(async () => undefined),
    releaseMedia: jest.fn(async () => undefined),
    freeBytes: jest.fn(async () => 0),
    fits: jest.fn(() => true),
    pickMedia: jest.fn(async () => []),
    pickFiles: jest.fn(async () => []),
    pickFolder: jest.fn(async () => null),
    DEFAULT_ITEM_BYTES: 50 * 1024 ** 2,
  };
});

import { createBatchDriver, fits, releaseMedia } from '@daak/platform';
import { Platform } from 'react-native';
import type { DaakEngine, DaakEvent } from '@daak/core';

const g = globalThis as unknown as {
  __batchDriver: Record<string, jest.Mock>;
  __batchEngine: DaakEngine;
  __sweep: { run: () => Promise<void> };
};
const driver = () => g.__batchDriver;
const handlers = (): Set<(e: DaakEvent) => void> =>
  (g.__batchEngine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers;
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

const A = 'aa'.repeat(16);
const B = 'bb'.repeat(16);

beforeEach(() => {
  jest.clearAllMocks();
  g.__sweep.run = async () => {};
  jest.spyOn(g.__batchEngine, 'devices').mockResolvedValue([
    { deviceId: A, name: 'Paired', online: true, paired: true },
    { deviceId: B, name: 'Seen only', online: true, paired: false },
  ] as Awaited<ReturnType<DaakEngine['devices']>>);
});

describe('the batch driver wiring', () => {
  it('the driver gets the events of the one engine.on handler and there is no second engine.on', async () => {
    const on = jest.spyOn(g.__batchEngine, 'on');
    await startEngine();
    expect(on).toHaveBeenCalledTimes(1);
    expect(handlers().size).toBe(1);
    const done: DaakEvent = { type: 'transfer.done', transferId: 't1' } as DaakEvent;
    const failed: DaakEvent = { type: 'transfer.failed', transferId: 't2' } as DaakEvent;
    for (const h of handlers()) {
      h(done);
      h(failed);
    }
    expect(driver().onEvent).toHaveBeenCalledWith(done);
    expect(driver().onEvent).toHaveBeenCalledWith(failed);
    // One driver for the process, even when startEngine runs twice.
    await startEngine();
    expect(createBatchDriver).toHaveBeenCalledTimes(1);
  });

  it('resume runs after the sweep promise resolves (a deferred sweep: resume is not called before it resolves)', async () => {
    let finish: () => void = () => {};
    g.__sweep.run = () => new Promise<void>((r) => { finish = r; });
    await startEngine();
    await flush();
    expect(driver().resume).not.toHaveBeenCalled();
    finish();
    await flush();
    expect(driver().resume).toHaveBeenCalledTimes(1);
  });

  it('resume gets only the paired peers', async () => {
    await startEngine();
    await flush();
    expect(driver().resume).toHaveBeenCalledWith([A]);
  });

  it('a devices() failure does not fail startEngine', async () => {
    // The sweep is deferred, so devices() fails only for the resume read. The
    // intent drain of startEngine reads devices() too, and that is not under test.
    let finish: () => void = () => {};
    g.__sweep.run = () => new Promise<void>((r) => { finish = r; });
    await expect(startEngine()).resolves.toBeUndefined();
    jest.spyOn(g.__batchEngine, 'devices').mockRejectedValue(new Error('down'));
    finish();
    await flush();
    expect(driver().resume).not.toHaveBeenCalled();
  });

  it('a resume failure does not fail startEngine', async () => {
    driver().resume.mockRejectedValue(new Error('boom'));
    await expect(startEngine()).resolves.toBeUndefined();
    await flush();
  });

  it('startLarge calls driver.start', async () => {
    await startEngine();
    const refs = [{ token: 't1', name: 'a.jpg', size: 10 }];
    await attachedMedia.startLarge?.(A, refs);
    expect(driver().start).toHaveBeenCalledWith(A, refs);
  });

  it('fits counts twice the size on Android, because staging copies each file', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    await attachedMedia.fits([{ token: 't1', name: 'a.jpg', size: 10 }]);
    expect(fits).toHaveBeenLastCalledWith(20, 0);
  });

  it('fits counts the size once on iOS, because staging makes a hard link', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    await attachedMedia.fits([{ token: 't1', name: 'a.jpg', size: 10 }]);
    expect(fits).toHaveBeenLastCalledWith(10, 0);
  });

  // One driver for the process: the deps are kept from the first start.
  const driverRelease = () =>
    (globalThis as unknown as { __batchDeps: { media: { release: (t: string[]) => Promise<void> } } }).__batchDeps
      .media.release;

  it('the media.release of the driver calls releaseMedia', async () => {
    await startEngine();
    await driverRelease()(['t1']);
    expect(releaseMedia).toHaveBeenCalledWith(['t1']);
  });

  // Item A: the end of a plan must not give back a token that a composer holds now.
  it('the release of the driver skips a token that a composer holds, until the composer gives it back', async () => {
    await startEngine();
    attachedMedia.hold?.(['t1']);
    await driverRelease()(['t1', 't2']);
    expect(releaseMedia).toHaveBeenCalledTimes(1);
    expect(releaseMedia).toHaveBeenCalledWith(['t2']);
    await driverRelease()(['t1']);
    expect(releaseMedia).toHaveBeenCalledTimes(1);
    await attachedMedia.release?.(['t1']);
    await driverRelease()(['t1']);
    expect(releaseMedia).toHaveBeenLastCalledWith(['t1']);
  });

  it('two composers that hold one token keep it until both give it back', async () => {
    await startEngine();
    attachedMedia.hold?.(['t1']);
    attachedMedia.hold?.(['t1']);
    await attachedMedia.release?.(['t1']);
    await driverRelease()(['t1']);
    expect(releaseMedia).not.toHaveBeenCalled();
    await attachedMedia.release?.(['t1']);
    await driverRelease()(['t1']);
    expect(releaseMedia).toHaveBeenCalledWith(['t1']);
  });

  // F2: the driver removes the tokens that a plan holds before the native call.
  it('the composer media host releases through the driver', async () => {
    await startEngine();
    await attachedMedia.release?.(['t1']);
    expect(driver().release).toHaveBeenCalledWith(['t1']);
    expect(releaseMedia).not.toHaveBeenCalled();
  });

  it('a release before the engine starts gives back nothing, because no plan is read yet', async () => {
    let fresh!: typeof import('../SendFlow');
    jest.isolateModules(() => {
      fresh = require('../SendFlow');
    });
    await expect(fresh.attachedMedia.release?.(['t1'])).resolves.toBeUndefined();
    const isolated = jest.requireMock('@daak/platform') as { releaseMedia: jest.Mock };
    expect(isolated.releaseMedia).not.toHaveBeenCalled();
    expect(releaseMedia).not.toHaveBeenCalled();
  });
});
