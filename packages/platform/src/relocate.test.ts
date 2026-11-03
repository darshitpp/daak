import { beforeEach, describe, expect, it, vi } from 'vitest';

// The native module is replaced outright: the real one resolves a TurboModule
// with getEnforcing at import time and there is no bridge here.
const moveReceivedFiles = vi.fn<(paths: string[], subdirs?: string[]) => Promise<string[]>>();
const saveToLibrary = vi.fn<(paths: string[], albums?: string[]) => Promise<string[]>>();
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
    // The spread keeps the exact argument count, so a test can see that the
    // facade always sends the second, parallel argument.
    moveReceivedFiles: (...args: [string[], string[]?]) => moveReceivedFiles(...args),
    saveToLibrary: (...args: [string[], string[]?]) => saveToLibrary(...args),
    requestPhotosAccess: vi.fn(),
    photosAccessStatus: vi.fn(),
  },
}));

import {
  moveReceivedFiles as facadeMove,
  planRelocation,
  relocateReceivedFiles,
  saveToLibrary as facadeSave,
} from './fspaths';

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
  await relocateReceivedFiles(engine, { payloadId: 'p', savedPaths: [], groupRoots: [] });
  await relocateReceivedFiles(engine, { payloadId: 'p', savedPaths: null, groupRoots: [] });
  expect(moveReceivedFiles).not.toHaveBeenCalled();
  expect(engine.calls).toHaveLength(0);
});

// The headline: the files moved, so the row must name the new places. A stale
// path here is an Inbox row whose open verb reaches a file that is gone.
it('records the new locations after a move', async () => {
  moveReceivedFiles.mockResolvedValue(['/Users/me/Downloads/a.jpg']);
  const engine = engineSpy();
  await expect(
    relocateReceivedFiles(engine, { payloadId: 'p', savedPaths: ['/app/downloads/a.jpg'], groupRoots: [] }),
  ).resolves.toEqual(['/Users/me/Downloads/a.jpg']);
  expect(engine.calls).toEqual([{ payloadId: 'p', paths: ['/Users/me/Downloads/a.jpg'] }]);
});

// Nothing moved means nothing to record, and the input coming back UNCHANGED is
// exactly what the native side answers with no folder chosen.
it('writes nothing when every path stayed put', async () => {
  moveReceivedFiles.mockImplementation(async (paths) => paths);
  const engine = engineSpy();
  await relocateReceivedFiles(engine, { payloadId: 'p', savedPaths: ['/app/downloads/a.jpg'], groupRoots: [] });
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
    relocateReceivedFiles(engine, { payloadId: 'p', savedPaths: ['/app/downloads/a.jpg'], groupRoots: [] }),
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
    relocateReceivedFiles(failing, { payloadId: 'p', savedPaths: ['/app/downloads/a.jpg'], groupRoots: [] }),
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
      groupRoots: [],
    }),
  ).resolves.toEqual(['photos:ID1', '/Users/me/Downloads/b.pdf']);
  expect(saveToLibrary).toHaveBeenCalledWith(['/app/a.JPG'], ['']);
  expect(moveReceivedFiles).toHaveBeenCalledWith(['/app/b.pdf'], ['']);
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
    relocateReceivedFiles(engine, { payloadId: 'p', savedPaths: ['/app/a.jpg'], groupRoots: [] }),
  ).resolves.toEqual(['/Users/me/Downloads/a.jpg']);
  expect(moveReceivedFiles).toHaveBeenCalledWith(['/app/a.jpg'], ['']);
});

// Two files with one name stay two entries.
it('keeps two media files with the same name apart', async () => {
  saveToLibrary.mockResolvedValue(['photos:ID1', 'photos:ID2']);
  const engine = engineSpy();
  await expect(
    relocateReceivedFiles(engine, {
      payloadId: 'p',
      savedPaths: ['/app/1/a.jpg', '/app/2/a.jpg'],
      groupRoots: [],
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
    relocateReceivedFiles(engine, { payloadId: 'p', savedPaths: ['/app/a.jpg'], groupRoots: [] }),
  ).resolves.toEqual(['/Users/me/Downloads/a.jpg']);
});

// The library result has the wrong length: ignore it, never misalign paths.
it('ignores a library answer of the wrong length', async () => {
  saveToLibrary.mockResolvedValue([]);
  moveReceivedFiles.mockImplementation(async (paths) => paths);
  const engine = engineSpy();
  await expect(
    relocateReceivedFiles(engine, { payloadId: 'p', savedPaths: ['/app/a.jpg'], groupRoots: [] }),
  ).resolves.toBeNull();
  expect(engine.calls).toHaveLength(0);
});

// No media: the library is not called at all.
it('does not call the library for non-media files', async () => {
  moveReceivedFiles.mockImplementation(async (paths) => paths);
  const engine = engineSpy();
  await relocateReceivedFiles(engine, { payloadId: 'p', savedPaths: ['/app/b.pdf'], groupRoots: [] });
  expect(saveToLibrary).not.toHaveBeenCalled();
});

// Task 10: a received folder. The engine writes it to <out_dir>/<group>/...
// and the event entry names each group directory in `groupRoots`.
describe('planRelocation', () => {
  it('all_media_folder_goes_to_the_library_with_its_structure', () => {
    expect(
      planRelocation(['/out/album/a.jpg', '/out/album/sub/b.mov'], ['/out/album'], true),
    ).toEqual({
      library: [
        { index: 0, path: '/out/album/a.jpg', album: 'album', subdir: 'album' },
        { index: 1, path: '/out/album/sub/b.mov', album: 'album / sub', subdir: 'album/sub' },
      ],
      folder: [],
    });
  });

  it('mixed_folder_splits_media_to_the_library_and_rest_to_the_save_folder_inside_the_group_folder', () => {
    expect(
      planRelocation(
        ['/out/album/a.jpg', '/out/album/sub/notes.pdf', '/out/album/c.txt'],
        ['/out/album'],
        true,
      ),
    ).toEqual({
      library: [{ index: 0, path: '/out/album/a.jpg', album: 'album', subdir: 'album' }],
      folder: [
        { index: 1, path: '/out/album/sub/notes.pdf', subdir: 'album/sub' },
        { index: 2, path: '/out/album/c.txt', subdir: 'album' },
      ],
    });
  });

  it('no_media_folder_goes_to_the_save_folder_inside_the_group_folder', () => {
    expect(
      planRelocation(['/out/docs/a.pdf', '/out/docs/x/y/b.txt'], ['/out/docs'], true),
    ).toEqual({
      library: [],
      folder: [
        { index: 0, path: '/out/docs/a.pdf', subdir: 'docs' },
        { index: 1, path: '/out/docs/x/y/b.txt', subdir: 'docs/x/y' },
      ],
    });
  });

  it('no_photos_routing_sends_the_whole_folder_to_the_save_folder', () => {
    expect(
      planRelocation(['/out/album/a.jpg', '/out/album/sub/b.pdf'], ['/out/album'], false),
    ).toEqual({
      library: [],
      folder: [
        { index: 0, path: '/out/album/a.jpg', subdir: 'album' },
        { index: 1, path: '/out/album/sub/b.pdf', subdir: 'album/sub' },
      ],
    });
  });

  it('a_loose_photo_keeps_todays_behaviour', async () => {
    expect(planRelocation(['/out/a.jpg', '/out/b.pdf'], [], true)).toEqual({
      library: [{ index: 0, path: '/out/a.jpg', album: '', subdir: '' }],
      folder: [{ index: 1, path: '/out/b.pdf', subdir: '' }],
    });
    // A loose file gets '' in the second, parallel array. The bridge always
    // gets 2 arrays, because an Objective-C selector has a fixed argument list.
    saveToLibrary.mockResolvedValue(['photos:ID1']);
    moveReceivedFiles.mockResolvedValue(['/save/b.pdf']);
    const engine = engineSpy();
    await expect(
      relocateReceivedFiles(engine, {
        payloadId: 'p',
        savedPaths: ['/out/a.jpg', '/out/b.pdf'],
        groupRoots: [],
      }),
    ).resolves.toEqual(['photos:ID1', '/save/b.pdf']);
    expect(saveToLibrary.mock.calls).toEqual([[['/out/a.jpg'], ['']]]);
    expect(moveReceivedFiles.mock.calls).toEqual([[['/out/b.pdf'], ['']]]);
  });

  it('two_groups_with_one_album_name_stay_apart', () => {
    // The sender gives two folders named `photos` the names `photos` and
    // `photos~1`. A root must match on a whole path component.
    expect(
      planRelocation(
        ['/out/photos/a.jpg', '/out/photos~1/a.jpg', '/out/photos~1/s/b.pdf'],
        ['/out/photos', '/out/photos~1'],
        true,
      ),
    ).toEqual({
      library: [
        { index: 0, path: '/out/photos/a.jpg', album: 'photos', subdir: 'photos' },
        { index: 1, path: '/out/photos~1/a.jpg', album: 'photos~1', subdir: 'photos~1' },
      ],
      folder: [{ index: 2, path: '/out/photos~1/s/b.pdf', subdir: 'photos~1/s' }],
    });
  });
});

describe('relocateReceivedFiles with a folder', () => {
  it('a_failed_library_save_leaves_the_files_in_the_save_folder_inside_their_group', async () => {
    // The library refuses (no permission, or no routing): the input comes back.
    saveToLibrary.mockImplementation(async (paths) => paths);
    moveReceivedFiles.mockResolvedValue(['/save/album/a.jpg', '/save/album/sub/b.mov']);
    const engine = engineSpy();
    await expect(
      relocateReceivedFiles(engine, {
        payloadId: 'p',
        savedPaths: ['/out/album/a.jpg', '/out/album/sub/b.mov'],
        groupRoots: ['/out/album'],
      }),
    ).resolves.toEqual(['/save/album/a.jpg', '/save/album/sub/b.mov']);
    expect(saveToLibrary).toHaveBeenCalledWith(
      ['/out/album/a.jpg', '/out/album/sub/b.mov'],
      ['album', 'album / sub'],
    );
    expect(moveReceivedFiles).toHaveBeenCalledWith(
      ['/out/album/a.jpg', '/out/album/sub/b.mov'],
      ['album', 'album/sub'],
    );
  });

  it('a_short_native_result_leaves_those_files_in_place_and_the_fallback_moves_them', async () => {
    // A library answer of the wrong length is ignored as a whole, so no path
    // is paired with the wrong file. The fallback move then takes every file.
    saveToLibrary.mockResolvedValue(['photos:ID1']);
    moveReceivedFiles.mockResolvedValue([
      '/save/album/a.jpg',
      '/save/album/b.jpg',
      '/save/album/c.pdf',
    ]);
    const engine = engineSpy();
    await expect(
      relocateReceivedFiles(engine, {
        payloadId: 'p',
        savedPaths: ['/out/album/a.jpg', '/out/album/b.jpg', '/out/album/c.pdf'],
        groupRoots: ['/out/album'],
      }),
    ).resolves.toEqual(['/save/album/a.jpg', '/save/album/b.jpg', '/save/album/c.pdf']);
    expect(moveReceivedFiles).toHaveBeenCalledWith(
      ['/out/album/a.jpg', '/out/album/b.jpg', '/out/album/c.pdf'],
      ['album', 'album', 'album'],
    );

    // A move answer of the wrong length is ignored too: the files stay.
    saveToLibrary.mockImplementation(async (paths) => paths);
    moveReceivedFiles.mockResolvedValue(['/save/album/a.pdf']);
    const quiet = engineSpy();
    await expect(
      relocateReceivedFiles(quiet, {
        payloadId: 'p',
        savedPaths: ['/out/album/a.pdf', '/out/album/b.pdf'],
        groupRoots: ['/out/album'],
      }),
    ).resolves.toBeNull();
    expect(quiet.calls).toHaveLength(0);
  });

  it('the_inbox_row_is_rewritten_with_every_new_path', async () => {
    // A resumed transfer: savedPaths holds every file of the folder, also the
    // files from the first connection. All of them move.
    saveToLibrary.mockResolvedValue(['photos:A', 'photos:C']);
    moveReceivedFiles.mockResolvedValue(['/save/album/sub/b.pdf', '/save/x.txt']);
    const engine = engineSpy();
    const after = ['photos:A', '/save/album/sub/b.pdf', 'photos:C', '/save/x.txt'];
    await expect(
      relocateReceivedFiles(engine, {
        payloadId: 'p',
        savedPaths: ['/out/album/a.jpg', '/out/album/sub/b.pdf', '/out/album/c.mov', '/out/x.txt'],
        groupRoots: ['/out/album'],
      }),
    ).resolves.toEqual(after);
    expect(moveReceivedFiles).toHaveBeenCalledWith(
      ['/out/album/sub/b.pdf', '/out/x.txt'],
      ['album/sub', ''],
    );
    expect(engine.calls).toEqual([{ payloadId: 'p', paths: after }]);
  });

  it('a_second_relocation_of_the_same_payload_moves_nothing_twice', async () => {
    // A repaired folder sends a second inbox.received. Its savedPaths still
    // lists the files that moved the first time: a Photos marker, a Gallery
    // URI, and a file in the save folder. The native move answers a file that
    // is already in the save folder with its own path.
    moveReceivedFiles.mockImplementation(async (paths) =>
      paths.map((p) => (p === '/out/album/new.pdf' ? '/save/album/new.pdf' : p)),
    );
    const moved = [
      'photos:ID1',
      'content://media/external/images/media/7',
      '/save/album/old.pdf',
    ];
    const engine = engineSpy();
    await expect(
      relocateReceivedFiles(engine, {
        payloadId: 'p',
        savedPaths: [...moved, '/out/album/new.pdf'],
        groupRoots: ['/save/album', '/out/album'],
      }),
    ).resolves.toEqual([...moved, '/save/album/new.pdf']);
    expect(saveToLibrary).not.toHaveBeenCalled();
    expect(moveReceivedFiles).toHaveBeenCalledWith(
      ['/save/album/old.pdf', '/out/album/new.pdf'],
      ['album', 'album'],
    );
    expect(engine.calls).toEqual([{ payloadId: 'p', paths: [...moved, '/save/album/new.pdf'] }]);

    // A third event with no new file: nothing moves and the row is not rewritten.
    moveReceivedFiles.mockClear();
    const again = engineSpy();
    await expect(
      relocateReceivedFiles(again, {
        payloadId: 'p',
        savedPaths: [...moved, '/save/album/new.pdf'],
        groupRoots: ['/save/album'],
      }),
    ).resolves.toBeNull();
    expect(saveToLibrary).not.toHaveBeenCalled();
    expect(again.calls).toHaveLength(0);
  });
});

// Task 11: the native selector has a fixed argument list. The facade always
// sends a second array with one entry for each path.
describe('the facade pads the parallel array', () => {
  it('sends one entry for each path, with the empty string for a missing one', async () => {
    saveToLibrary.mockImplementation(async (paths) => paths);
    moveReceivedFiles.mockImplementation(async (paths) => paths);
    await facadeSave(['/a.jpg', '/b.jpg'], ['album']);
    await facadeMove(['/a.pdf', '/b.pdf']);
    await facadeMove(['/c.pdf'], ['album/sub', 'extra']);
    expect(saveToLibrary.mock.calls).toEqual([[['/a.jpg', '/b.jpg'], ['album', '']]]);
    expect(moveReceivedFiles.mock.calls).toEqual([
      [['/a.pdf', '/b.pdf'], ['', '']],
      [['/c.pdf'], ['album/sub']],
    ]);
  });
});
