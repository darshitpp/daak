import { describe, expect, it, vi } from 'vitest';

vi.mock('@daak/rn-share', () => ({
  default: {
    present: vi.fn(async () => {}),
    pickDocuments: vi.fn(async () => ['/tmp/a.pdf']),
    pickFolder: vi.fn(async () => '/tmp/dir'),
    consumePendingInbox: vi.fn(async () => '[]'),
    addListener: () => {},
    removeListeners: () => {},
  },
}));

import DaakShare from '@daak/rn-share';
import { consumePendingInbox, pickFiles, pickFolder, presentShare } from './share';

const native = vi.mocked(DaakShare);
// The folder method is a plain mock at run time. This view gives the test the
// mock API. macOS does not register this module, so a test still removes it.
const folderMock = native as unknown as { pickFolder: ReturnType<typeof vi.fn> };

describe('share facade', () => {
  it('forwards text and urls to the native presenter', async () => {
    await presentShare({ text: 'hi', urls: ['/tmp/a.pdf'], mime: 'application/pdf' });
    expect(native.present).toHaveBeenCalledWith('hi', ['/tmp/a.pdf'], 'application/pdf');
  });

  // An empty mime is the honest "no preference": the native side then derives
  // the type per document. A '*/*' default here made the native derivation dead
  // code, and the chooser listed every app that accepts any file.
  it('sends no mime when none is given, so the native side derives the type', async () => {
    await presentShare({ urls: ['/tmp/a.pdf'] });
    expect(native.present).toHaveBeenLastCalledWith('', ['/tmp/a.pdf'], '');
  });

  it('exposes the document picker', async () => {
    await expect(pickFiles(true)).resolves.toEqual(['/tmp/a.pdf']);
  });

  it('forwards the staged inbox to the caller', async () => {
    // The native contract is a JSON string (Task 5's inbound.ts parses it); this
    // pins the pass-through and the empty-inbox shape, not a re-parse here.
    const raw = await consumePendingInbox();
    expect(native.consumePendingInbox).toHaveBeenCalledTimes(1);
    expect(JSON.parse(raw)).toEqual([]);
  });

  // A Photos marker is not a file. The share sheet needs a real file.
  it('drops Photos markers and keeps real paths and content URIs', async () => {
    native.present.mockClear();
    await presentShare({
      urls: ['photos:ABC', '/app/a.pdf', 'content://media/external/images/media/9'],
    });
    expect(native.present).toHaveBeenCalledWith(
      '',
      ['/app/a.pdf', 'content://media/external/images/media/9'],
      '',
    );
  });

  // A share with only markers has nothing to hand to the sheet.
  it('does not open the sheet when only markers remain and there is no text', async () => {
    native.present.mockClear();
    await presentShare({ urls: ['photos:ABC'] });
    expect(native.present).not.toHaveBeenCalled();
  });

  it('still shares text when every url was a marker', async () => {
    native.present.mockClear();
    await presentShare({ text: 'hello', urls: ['photos:ABC'] });
    expect(native.present).toHaveBeenCalledWith('hello', [], '');
  });
});

describe('pickFolder', () => {
  it('resolves the chosen folder path', async () => {
    await expect(pickFolder()).resolves.toBe('/tmp/dir');
  });

  it('resolves null when the user cancels, even if the bridge gives undefined', async () => {
    folderMock.pickFolder.mockResolvedValueOnce(undefined as unknown as null);
    await expect(pickFolder()).resolves.toBeNull();
  });

  it('keeps the NO_SPACE message with the needed bytes', async () => {
    folderMock.pickFolder.mockRejectedValueOnce(new Error('NO_SPACE:123'));
    await expect(pickFolder()).rejects.toThrow(new Error('NO_SPACE:123'));
  });

  it('builds the message from the native error code', async () => {
    folderMock.pickFolder.mockRejectedValueOnce(
      Object.assign(new Error('123'), { code: 'NO_SPACE' }),
    );
    await expect(pickFolder()).rejects.toThrow('NO_SPACE:123');
    folderMock.pickFolder.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'EMPTY' }));
    await expect(pickFolder()).rejects.toThrow(/^EMPTY$/);
    folderMock.pickFolder.mockRejectedValueOnce(
      Object.assign(new Error('x'), { code: 'NOT_DOWNLOADED' }),
    );
    await expect(pickFolder()).rejects.toThrow(/^NOT_DOWNLOADED$/);
  });

  // An iCloud Drive file that is not on the device is a placeholder. iOS
  // refuses the whole pick, so the send never carries the placeholder.
  it('keeps the NOT_DOWNLOADED message', async () => {
    folderMock.pickFolder.mockRejectedValueOnce(new Error('NOT_DOWNLOADED'));
    await expect(pickFolder()).rejects.toThrow(/^NOT_DOWNLOADED$/);
  });

  it('fails loudly when the platform has no native pickFolder', async () => {
    const saved = native.pickFolder;
    (native as { pickFolder?: unknown }).pickFolder = undefined;
    await expect(pickFolder()).rejects.toThrow(/pickFolder/);
    (native as { pickFolder?: unknown }).pickFolder = saved;
  });
});
