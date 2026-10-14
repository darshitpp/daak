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
  it('shows the last segment as is when a percent sequence is malformed', () => {
    expect(f('content://com.example.provider/tree/%E0%A4%A')).toBe('%E0%A4%A');
    expect(f(`${SAF}%E0%A4%A`)).toBe('%E0%A4%A');
  });
  it('keeps the middle ellipsis at the exact position of the cap', () => {
    // 20 head characters, the ellipsis, then 19 tail characters.
    const name = 'a'.repeat(20) + 'b'.repeat(30) + 'c'.repeat(19);
    expect(f('/x/' + name)).toBe('x / ' + name.slice(0, 16) + '\u2026' + name.slice(-19));
    expect(f(`${SAF}primary%3A` + encodeURIComponent('a'.repeat(30) + 'z'.repeat(30)))).toBe(
      'a'.repeat(20) + '\u2026' + 'z'.repeat(19),
    );
  });
  it('counts code points and never splits a surrogate pair', () => {
    const name = 'a'.repeat(19) + '\u{1F600}' + 'b'.repeat(40);
    const out = f(`${SAF}primary%3A` + encodeURIComponent(name));
    expect(out).toBe('a'.repeat(19) + '\u{1F600}' + '\u2026' + 'b'.repeat(19));
    expect(Array.from(out)).toHaveLength(40);
    // A lone surrogate would not survive a round trip through UTF-8.
    expect(out).toBe(Buffer.from(out, 'utf8').toString('utf8'));
  });
  it('does not return a raw content URI that is not a tree URI', () => {
    expect(f('content://com.google.android.apps.docs.storage/document/abc')).toBe('abc');
    expect(f('content://com.google.android.apps.docs.storage/document/a%20b/')).toBe('a b');
    expect(f('content://com.example.provider')).toBe('example.provider');
    expect(f('content://com.example.provider/')).toBe('example.provider');
    expect(f('content://com.example.provider/document/%E0%A4%A')).toBe('%E0%A4%A');
  });
  it('shows Documents for the home volume', () => {
    expect(f(`${SAF}home%3ADocs`)).toBe('Documents / Docs');
    expect(f(`${SAF}home%3A`)).toBe('Documents');
  });
  it('shows the path after raw:', () => {
    expect(f(`${SAF}raw%3A%2Fstorage%2Femulated%2F0%2FDownload`)).toBe('/storage/emulated/0/Download');
  });
  it('shows SD card only for a volume id of the form XXXX-XXXX', () => {
    expect(f(`${SAF}1a2b-3C4D%3A`)).toBe('SD card');
    expect(f(`${SAF}1A2B-3C4D%3AMusic%2FDaak`)).toBe('SD card / Music/Daak');
  });
  it('shows another volume id as is', () => {
    expect(f(`${SAF}usbstick%3AFiles`)).toBe('usbstick / Files');
    expect(f(`${SAF}usbstick%3A`)).toBe('usbstick');
  });
  it('splits a Windows path on backslashes', () => {
    expect(f('C:\\Users\\me\\Daak')).toBe('me / Daak');
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
