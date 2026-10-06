import { beforeEach, describe, expect, it, vi } from 'vitest';

// The native module is replaced outright: the real one resolves a TurboModule
// with getEnforcing at import time and there is no bridge here.
const moveReceivedFiles = vi.fn<(paths: string[]) => Promise<string[]>>();
vi.mock('@daak/rn-fspaths', () => ({
  default: {
    documentsDir: vi.fn(),
    downloadsDir: vi.fn(),
    appGroupDir: vi.fn(),
    reveal: vi.fn(),
    exists: vi.fn(),
    chooseDownloadFolder: vi.fn(),
    downloadFolderName: vi.fn(),
    clearDownloadFolder: vi.fn(),
    moveReceivedFiles: (paths: string[]) => moveReceivedFiles(paths),
  },
}));

import { relocateReceivedFiles } from './fspaths';

function engineSpy() {
  const calls: Array<{ payloadId: string; paths: string[] }> = [];
  return {
    calls,
    replaceInboxPaths: async (payloadId: string, paths: string[]) => {
      calls.push({ payloadId, paths });
    },
  };
}

beforeEach(() => {
  moveReceivedFiles.mockReset();
});

// R42p: a payload with no saved paths needs no move and no write. A write per
// receive for nothing is a row rewritten on every arrival.
it('does nothing for a payload with no files', async () => {
  const engine = engineSpy();
  await relocateReceivedFiles(engine, { payloadId: 'p', savedPaths: [] });
  await relocateReceivedFiles(engine, { payloadId: 'p', savedPaths: null });
  expect(moveReceivedFiles).not.toHaveBeenCalled();
  expect(engine.calls).toHaveLength(0);
});

// The headline: the files moved, so the row must name the new places. A stale
// path here is an Inbox row whose open verb reaches a file that is gone.
it('records the new locations after a move', async () => {
  moveReceivedFiles.mockResolvedValue(['/Users/me/Downloads/a.jpg']);
  const engine = engineSpy();
  await relocateReceivedFiles(engine, { payloadId: 'p', savedPaths: ['/app/downloads/a.jpg'] });
  expect(engine.calls).toEqual([{ payloadId: 'p', paths: ['/Users/me/Downloads/a.jpg'] }]);
});

// Nothing moved means nothing to record, and the input coming back UNCHANGED is
// exactly what the native side answers with no folder chosen.
it('writes nothing when every path stayed put', async () => {
  moveReceivedFiles.mockImplementation(async (paths) => paths);
  const engine = engineSpy();
  await relocateReceivedFiles(engine, { payloadId: 'p', savedPaths: ['/app/downloads/a.jpg'] });
  expect(engine.calls).toHaveLength(0);
});

// It runs inside the app's ONE engine event handler. An unhandled rejection
// there takes the subscription, and with it every later notification.
it('never throws when the move or the write fails', async () => {
  moveReceivedFiles.mockRejectedValue(new Error('no such folder'));
  const engine = engineSpy();
  await expect(
    relocateReceivedFiles(engine, { payloadId: 'p', savedPaths: ['/app/downloads/a.jpg'] }),
  ).resolves.toBeUndefined();
  expect(engine.calls).toHaveLength(0);

  moveReceivedFiles.mockResolvedValue(['/moved/a.jpg']);
  const failing = {
    replaceInboxPaths: async () => {
      throw new Error('database is locked');
    },
  };
  await expect(
    relocateReceivedFiles(failing, { payloadId: 'p', savedPaths: ['/app/downloads/a.jpg'] }),
  ).resolves.toBeUndefined();
});
