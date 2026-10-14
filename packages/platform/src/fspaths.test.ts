import { describe, expect, it, vi } from 'vitest';

vi.mock('@daak/rn-fspaths', () => ({
  default: {
    chooseDownloadFolder: vi.fn(async () => undefined),
    downloadFolderName: vi.fn(async () => null),
    openFile: vi.fn(),
    fileSizes: vi.fn(),
  },
}));

import NativeDaakFsPaths from '@daak/rn-fspaths';
import { chooseDownloadFolder, fileSizes, openFile } from './fspaths';

const native = vi.mocked(NativeDaakFsPaths);

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
