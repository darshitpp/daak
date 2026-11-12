import { describe, expect, it, vi } from 'vitest';

vi.mock('@daak/rn-share', () => ({
  default: {
    present: vi.fn(async () => {}),
    pickDocuments: vi.fn(async () => ['/tmp/a.pdf']),
    pickFolder: vi.fn(async () => '/tmp/dir'),
    pickMedia: vi.fn(async () => '[]'),
    materialize: vi.fn(async () => '/cache/daak-send/U1/a.mp4'),
    releaseMedia: vi.fn(async () => {}),
    consumePendingInbox: vi.fn(async () => '[]'),
    addListener: () => {},
    removeListeners: () => {},
  },
}));

import DaakShare from '@daak/rn-share';
import {
  consumePendingInbox,
  materializeMedia,
  pickFiles,
  pickFolder,
  pickMedia,
  presentShare,
  releaseMedia,
} from './share';

const native = vi.mocked(DaakShare);
// The folder method is a plain mock at run time. This view gives the test the
// mock API. macOS does not register this module, so a test still removes it.
const folderMock = native as unknown as { pickFolder: ReturnType<typeof vi.fn> };
const mediaMock = native as unknown as {
  pickMedia: ReturnType<typeof vi.fn>;
  materialize: ReturnType<typeof vi.fn>;
};

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

describe('pickMedia', () => {
  it('pickMedia parses the JSON into refs', async () => {
    mediaMock.pickMedia.mockResolvedValueOnce(
      JSON.stringify([
        { token: 'content://media/1', name: 'a.mp4', size: 10 },
        { token: 'content://media/2', name: 'b.jpg', size: null },
      ]),
    );
    await expect(pickMedia()).resolves.toEqual([
      { token: 'content://media/1', name: 'a.mp4', size: 10 },
      { token: 'content://media/2', name: 'b.jpg', size: null },
    ]);
  });

  it('a cancelled pick gives an empty list', async () => {
    mediaMock.pickMedia.mockResolvedValueOnce('[]');
    await expect(pickMedia()).resolves.toEqual([]);
    mediaMock.pickMedia.mockResolvedValueOnce(undefined);
    await expect(pickMedia()).resolves.toEqual([]);
  });

  it('an invalid entry is dropped', async () => {
    mediaMock.pickMedia.mockResolvedValueOnce(
      JSON.stringify([
        { token: 't1', name: 'ok', size: 0 },
        { token: 1, name: 'bad token', size: 1 },
        { token: 't3', name: 4, size: 1 },
        { token: 't4', name: 'negative', size: -1 },
        { token: 't5', name: 'missing size' },
        null,
        'text',
      ]),
    );
    await expect(pickMedia()).resolves.toEqual([{ token: 't1', name: 'ok', size: 0 }]);
  });

  it('E_TOO_MANY is mapped to a fixed error', async () => {
    mediaMock.pickMedia.mockRejectedValueOnce(
      Object.assign(new Error('too many items; pick fewer'), { code: 'E_TOO_MANY' }),
    );
    await expect(pickMedia()).rejects.toThrow(/^E_TOO_MANY$/);
    mediaMock.pickMedia.mockRejectedValueOnce(new Error('E_TOO_MANY'));
    await expect(pickMedia()).rejects.toThrow(/^E_TOO_MANY$/);
  });

  it('pickMedia rejects when the native module lacks the method', async () => {
    const saved = native.pickMedia;
    (native as { pickMedia?: unknown }).pickMedia = undefined;
    await expect(pickMedia()).rejects.toThrow(/pickMedia/);
    (native as { pickMedia?: unknown }).pickMedia = saved;
  });
});

describe('materializeMedia', () => {
  it('materializeMedia returns the path', async () => {
    await expect(materializeMedia('content://media/1')).resolves.toBe('/cache/daak-send/U1/a.mp4');
    expect(native.materialize).toHaveBeenLastCalledWith('content://media/1');
  });

  it('NO_SPACE:<n> and E_SOURCE_GONE are mapped like pickFolder maps its codes', async () => {
    mediaMock.materialize.mockRejectedValueOnce(Object.assign(new Error('123'), { code: 'NO_SPACE' }));
    await expect(materializeMedia('t')).rejects.toThrow(/^NO_SPACE:123$/);
    mediaMock.materialize.mockRejectedValueOnce(new Error('NO_SPACE:456'));
    await expect(materializeMedia('t')).rejects.toThrow(/^NO_SPACE:456$/);
    mediaMock.materialize.mockRejectedValueOnce(
      Object.assign(new Error('x'), { code: 'E_SOURCE_GONE' }),
    );
    await expect(materializeMedia('t')).rejects.toThrow(/^E_SOURCE_GONE$/);
    mediaMock.materialize.mockRejectedValueOnce(
      Object.assign(new Error('x'), { code: 'E_MATERIALIZE' }),
    );
    await expect(materializeMedia('t')).rejects.toThrow(/^E_MATERIALIZE$/);
  });

  it('NOT_DOWNLOADED keeps its own code and drops the native message', async () => {
    mediaMock.materialize.mockRejectedValueOnce(
      Object.assign(new Error('could not download IMG_1234.HEIC'), { code: 'NOT_DOWNLOADED' }),
    );
    await expect(materializeMedia('t')).rejects.toThrow(/^NOT_DOWNLOADED$/);
  });

  it('E_PICK_BUSY is mapped to a fixed error', async () => {
    mediaMock.pickMedia.mockRejectedValueOnce(
      Object.assign(new Error('a pick is open'), { code: 'E_PICK_BUSY' }),
    );
    await expect(pickMedia()).rejects.toThrow(/^E_PICK_BUSY$/);
  });

  it('an error message contains no uri', async () => {
    mediaMock.materialize.mockRejectedValueOnce(
      Object.assign(new Error('failed on content://media/external/video/media/7 (a.mp4)'), {
        code: 'E_SOURCE_GONE',
      }),
    );
    await expect(materializeMedia('content://media/external/video/media/7')).rejects.toThrow(
      /^E_SOURCE_GONE$/,
    );
    mediaMock.materialize.mockRejectedValueOnce(
      Object.assign(new Error('boom content://media/9'), { code: 'E_MATERIALIZE' }),
    );
    const err = await materializeMedia('content://media/9').catch((e) => e as Error);
    expect((err as Error).message).not.toContain('content://');
  });

  it('rejects when the native module lacks the method', async () => {
    const saved = native.materialize;
    (native as { materialize?: unknown }).materialize = undefined;
    await expect(materializeMedia('t')).rejects.toThrow(/materialize/);
    (native as { materialize?: unknown }).materialize = saved;
  });
});

describe('releaseMedia', () => {
  const releaseMock = native as unknown as { releaseMedia: ReturnType<typeof vi.fn> };

  it('passes the tokens to the native module as JSON text', async () => {
    await releaseMedia(['content://media/1', 'content://media/2']);
    expect(releaseMock.releaseMedia).toHaveBeenLastCalledWith('["content://media/1","content://media/2"]');
  });

  it('calls nothing for an empty list', async () => {
    releaseMock.releaseMedia.mockClear();
    await releaseMedia([]);
    expect(releaseMock.releaseMedia).not.toHaveBeenCalled();
  });

  it('never throws when the native call rejects', async () => {
    releaseMock.releaseMedia.mockRejectedValueOnce(new Error('no'));
    await expect(releaseMedia(['content://media/1'])).resolves.toBeUndefined();
  });

  it('resolves when the native module lacks the method', async () => {
    const saved = releaseMock.releaseMedia;
    (native as { releaseMedia?: unknown }).releaseMedia = undefined;
    await expect(releaseMedia(['t'])).resolves.toBeUndefined();
    (native as { releaseMedia?: unknown }).releaseMedia = saved;
  });
});
