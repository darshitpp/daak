import { beforeEach, describe, expect, it, vi } from 'vitest';

// The native module is replaced outright: the real one resolves a TurboModule
// with getEnforcing at import time and there is no bridge here.
const moveReceivedFiles = vi.fn<(paths: string[]) => Promise<string[]>>();
const saveToLibrary = vi.fn<(paths: string[]) => Promise<string[]>>();
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
    saveToLibrary: (paths: string[]) => saveToLibrary(paths),
    requestPhotosAccess: vi.fn(),
    photosAccessStatus: vi.fn(),
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
  saveToLibrary.mockReset();
  // The default native answer is "nothing saved": the input comes back.
  saveToLibrary.mockImplementation(async (paths) => paths);
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
  await expect(
    relocateReceivedFiles(engine, { payloadId: 'p', savedPaths: ['/app/downloads/a.jpg'] }),
  ).resolves.toEqual(['/Users/me/Downloads/a.jpg']);
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
  // A rejected move means nothing moved, so there are no new locations to
  // report: null, not an array of paths the caller must not use.
  await expect(
    relocateReceivedFiles(engine, { payloadId: 'p', savedPaths: ['/app/downloads/a.jpg'] }),
  ).resolves.toBeNull();
  expect(engine.calls).toHaveLength(0);

  moveReceivedFiles.mockResolvedValue(['/moved/a.jpg']);
  const failing = {
    replaceInboxPaths: async () => {
      throw new Error('database is locked');
    },
  };
  // The FILES moved even though the row could not be rewritten, so the caller
  // still has to learn where they are: a banner posted with the OLD paths would
  // name files the move already deleted.
  await expect(
    relocateReceivedFiles(failing, { payloadId: 'p', savedPaths: ['/app/downloads/a.jpg'] }),
  ).resolves.toEqual(['/moved/a.jpg']);
});

// Media goes to the library. Everything else goes to the folder move. The
// result keeps the order of savedPaths.
it('sends media to the library and other files to the move, in order', async () => {
  saveToLibrary.mockResolvedValue(['photos:ID1']);
  moveReceivedFiles.mockResolvedValue(['/Users/me/Downloads/b.pdf']);
  const engine = engineSpy();
  await expect(
    relocateReceivedFiles(engine, {
      payloadId: 'p',
      savedPaths: ['/app/a.JPG', '/app/b.pdf'],
    }),
  ).resolves.toEqual(['photos:ID1', '/Users/me/Downloads/b.pdf']);
  expect(saveToLibrary).toHaveBeenCalledWith(['/app/a.JPG']);
  expect(moveReceivedFiles).toHaveBeenCalledWith(['/app/b.pdf']);
  expect(engine.calls).toEqual([
    { payloadId: 'p', paths: ['photos:ID1', '/Users/me/Downloads/b.pdf'] },
  ]);
});

// Permission denied: the library hands the path back. The chosen folder then
// gets the file, as it did before this feature.
it('moves a media file the library did not take', async () => {
  saveToLibrary.mockImplementation(async (paths) => paths);
  moveReceivedFiles.mockResolvedValue(['/Users/me/Downloads/a.jpg']);
  const engine = engineSpy();
  await expect(
    relocateReceivedFiles(engine, { payloadId: 'p', savedPaths: ['/app/a.jpg'] }),
  ).resolves.toEqual(['/Users/me/Downloads/a.jpg']);
  expect(moveReceivedFiles).toHaveBeenCalledWith(['/app/a.jpg']);
});

// Two files with one name stay two entries.
it('keeps two media files with the same name apart', async () => {
  saveToLibrary.mockResolvedValue(['photos:ID1', 'photos:ID2']);
  const engine = engineSpy();
  await expect(
    relocateReceivedFiles(engine, {
      payloadId: 'p',
      savedPaths: ['/app/1/a.jpg', '/app/2/a.jpg'],
    }),
  ).resolves.toEqual(['photos:ID1', 'photos:ID2']);
  expect(moveReceivedFiles).not.toHaveBeenCalled();
});

// A library failure must not block the folder move or throw.
it('survives a rejected library save and still moves the file', async () => {
  saveToLibrary.mockRejectedValue(new Error('photos unavailable'));
  moveReceivedFiles.mockResolvedValue(['/Users/me/Downloads/a.jpg']);
  const engine = engineSpy();
  await expect(
    relocateReceivedFiles(engine, { payloadId: 'p', savedPaths: ['/app/a.jpg'] }),
  ).resolves.toEqual(['/Users/me/Downloads/a.jpg']);
});

// The library result has the wrong length: ignore it, never misalign paths.
it('ignores a library answer of the wrong length', async () => {
  saveToLibrary.mockResolvedValue([]);
  moveReceivedFiles.mockImplementation(async (paths) => paths);
  const engine = engineSpy();
  await expect(
    relocateReceivedFiles(engine, { payloadId: 'p', savedPaths: ['/app/a.jpg'] }),
  ).resolves.toBeNull();
  expect(engine.calls).toHaveLength(0);
});

// No media: the library is not called at all.
it('does not call the library for non-media files', async () => {
  moveReceivedFiles.mockImplementation(async (paths) => paths);
  const engine = engineSpy();
  await relocateReceivedFiles(engine, { payloadId: 'p', savedPaths: ['/app/b.pdf'] });
  expect(saveToLibrary).not.toHaveBeenCalled();
});
