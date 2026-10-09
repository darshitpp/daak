import { describe, expect, it, vi } from 'vitest';

vi.mock('@daak/rn-fspaths', () => ({
  default: {
    chooseDownloadFolder: vi.fn(async () => undefined),
    downloadFolderName: vi.fn(async () => null),
  },
}));

import NativeDaakFsPaths from '@daak/rn-fspaths';
import { chooseDownloadFolder } from './fspaths';

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

  it('passes a chosen folder through unchanged', async () => {
    native.chooseDownloadFolder.mockResolvedValueOnce('/a/folder');
    await expect(chooseDownloadFolder()).resolves.toBe('/a/folder');
  });
});
