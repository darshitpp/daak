import { describe, expect, it, vi } from 'vitest';

vi.mock('@daak/rn-fspaths', () => ({
  default: {
    chooseDownloadFolder: vi.fn(),
    downloadFolderName: vi.fn(),
  },
}));

import NativeDaakFsPaths from '@daak/rn-fspaths';
import { chooseDownloadFolder, downloadFolderName, friendlyFolderName as f } from './fspaths';

const native = vi.mocked(NativeDaakFsPaths);
const SAF = 'content://com.android.externalstorage.documents/tree/';

describe('friendlyFolderName', () => {
  it('shows the relative path of a primary SAF volume', () => {
    expect(f(`${SAF}primary%3ADownload%2FDaak`)).toBe('Download/Daak');
  });
  it('shows Internal storage for the primary root', () => {
    expect(f(`${SAF}primary%3A`)).toBe('Internal storage');
  });
  it('shows SD card plus the path for another volume', () => {
    expect(f(`${SAF}1A2B-3C4D%3APictures`)).toBe('SD card / Pictures');
  });
  it('ignores a /document/ suffix', () => {
    expect(f(`${SAF}primary%3ADownload%2FDaak/document/primary%3ADownload%2FDaak`)).toBe('Download/Daak');
  });
  it('uses the last segment for another authority', () => {
    expect(f('content://com.example.provider/tree/a%2Fb%2Fnotes')).toBe('notes');
  });
  it('uses the authority last two parts when no segment exists', () => {
    expect(f('content://com.example.provider/tree/')).toBe('example.provider');
  });
  it('shows iCloud Drive plus the part after CloudDocs', () => {
    expect(
      f('/private/var/mobile/Library/Mobile Documents/com~apple~CloudDocs/Daak'),
    ).toBe('iCloud Drive / Daak');
  });
  it('shows the last two components of an app container path', () => {
    expect(
      f('/private/var/mobile/Containers/Data/Application/ABC/Documents/Daak/downloads'),
    ).toBe('Daak / downloads');
  });
  it('shows one component when only one exists', () => {
    expect(f('/Downloads')).toBe('Downloads');
  });
  it('returns an empty string unchanged', () => {
    expect(f('')).toBe('');
  });
  it('returns an unparsable string unchanged', () => {
    expect(f('///')).toBe('///');
  });
  it('caps a 100 character name at 40 with a middle ellipsis', () => {
    const out = f('/a/' + 'x'.repeat(100));
    expect(out).toHaveLength(40);
    expect(out).toContain('…');
  });
});

describe('folder name facade', () => {
  it('downloadFolderName returns the friendly name and keeps null', async () => {
    native.downloadFolderName.mockResolvedValueOnce(`${SAF}primary%3ADownload%2FDaak`);
    await expect(downloadFolderName()).resolves.toBe('Download/Daak');
    native.downloadFolderName.mockResolvedValueOnce(null as unknown as string);
    await expect(downloadFolderName()).resolves.toBeNull();
  });
  it('chooseDownloadFolder returns the friendly name and keeps null', async () => {
    native.chooseDownloadFolder.mockResolvedValueOnce('/a/b/c');
    await expect(chooseDownloadFolder()).resolves.toBe('b / c');
    native.chooseDownloadFolder.mockResolvedValueOnce(undefined as unknown as string);
    await expect(chooseDownloadFolder()).resolves.toBeNull();
  });
});
