import { describe, expect, it, vi } from 'vitest';

vi.mock('@daak/rn-fspaths', () => ({
  default: {
    chooseDownloadFolder: vi.fn(async () => undefined),
    downloadFolderName: vi.fn(async () => null),
    openFile: vi.fn(),
    fileSizes: vi.fn(),
    folderStats: vi.fn(),
    discardPickedCopy: vi.fn(),
    sweepPickedCopies: vi.fn(),
  },
}));

import NativeDaakFsPaths from '@daak/rn-fspaths';
import {
  chooseDownloadFolder,
  discardPickedCopy,
  fileSizes,
  folderStats,
  openFile,
  sweepPickedCopies,
} from './fspaths';

const native = vi.mocked(NativeDaakFsPaths);
// The folder methods are plain mocks at run time. A test removes one, because
// an old native build can lack it.
const folderMocks = NativeDaakFsPaths as unknown as Record<
  'folderStats' | 'discardPickedCopy' | 'sweepPickedCopies',
  ReturnType<typeof vi.fn>
>;

describe('fspaths facade', () => {
  // A CANCELLED picker resolves `nil` natively, and the bridge delivers
  // `undefined` for it rather than `null`. DownloadFolderRow reads `null` as
  // "the user cancelled, change nothing" and any other value as a new name, so
  // an `undefined` slipped past its guard and set the name to undefined -- the
  // row fell back to "This app's own storage" and CLEARED a folder the user
  // still had. Measured on the iPhone 17 simulator: closing the picker reverted
  // a folder that had just been chosen.
  it('turns a cancelled picker into null, never undefined', async () => {
    native.chooseDownloadFolder.mockResolvedValueOnce(undefined as unknown as string);
    await expect(chooseDownloadFolder()).resolves.toBeNull();
  });

  it('returns a chosen folder as a friendly name', async () => {
    native.chooseDownloadFolder.mockResolvedValueOnce('/a/folder');
    await expect(chooseDownloadFolder()).resolves.toBe('a / folder');
  });

  it('openFile forwards the path and returns the native answer', async () => {
    native.openFile.mockResolvedValue(true);
    await expect(openFile('/data/daak/downloads/a.pdf')).resolves.toBe(true);
    expect(native.openFile).toHaveBeenCalledWith('/data/daak/downloads/a.pdf');
  });

  it('openFile resolves false when the native call rejects', async () => {
    native.openFile.mockRejectedValue(new Error('E_FSPATHS'));
    await expect(openFile('/gone')).resolves.toBe(false);
  });

  it('fileSizes forwards the paths and returns the native answer', async () => {
    native.fileSizes.mockResolvedValue([10, null]);
    await expect(fileSizes(['/a', '/gone'])).resolves.toEqual([10, null]);
    expect(native.fileSizes).toHaveBeenCalledWith(['/a', '/gone']);
  });

  it('fileSizes gives null for every path when the native call rejects', async () => {
    native.fileSizes.mockRejectedValue(new Error('E_FSPATHS'));
    await expect(fileSizes(['/a', '/b'])).resolves.toEqual([null, null]);
  });
});

describe('folder picker facade', () => {
  it('folderStats forwards the path and returns the counts', async () => {
    folderMocks.folderStats.mockResolvedValueOnce({ files: 3, bytes: 99 });
    await expect(folderStats('/d')).resolves.toEqual({ files: 3, bytes: 99 });
    expect(folderMocks.folderStats).toHaveBeenCalledWith('/d');
  });

  it('folderStats returns null when the native call rejects', async () => {
    folderMocks.folderStats.mockRejectedValueOnce(new Error('boom'));
    await expect(folderStats('/d')).resolves.toBeNull();
  });

  it('folderStats returns null when the native call is missing', async () => {
    const saved = folderMocks.folderStats;
    (native as { folderStats?: unknown }).folderStats = undefined;
    await expect(folderStats('/d')).resolves.toBeNull();
    (native as { folderStats?: unknown }).folderStats = saved;
  });

  it('discardPickedCopy forwards the path and never rejects', async () => {
    folderMocks.discardPickedCopy.mockResolvedValueOnce(undefined);
    await discardPickedCopy('/c');
    expect(folderMocks.discardPickedCopy).toHaveBeenCalledWith('/c');
    folderMocks.discardPickedCopy.mockRejectedValueOnce(new Error('boom'));
    await expect(discardPickedCopy('/c')).resolves.toBeUndefined();
  });

  it('sweepPickedCopies calls native and never rejects', async () => {
    folderMocks.sweepPickedCopies.mockResolvedValueOnce(undefined);
    await sweepPickedCopies();
    expect(folderMocks.sweepPickedCopies).toHaveBeenCalledTimes(1);
    folderMocks.sweepPickedCopies.mockRejectedValueOnce(new Error('boom'));
    await expect(sweepPickedCopies()).resolves.toBeUndefined();
  });
});
