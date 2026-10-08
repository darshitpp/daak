import { describe, expect, it, vi } from 'vitest';

vi.mock('@daak/rn-share', () => ({
  default: {
    present: vi.fn(async () => {}),
    pickDocuments: vi.fn(async () => ['/tmp/a.pdf']),
    consumePendingInbox: vi.fn(async () => '[]'),
    addListener: () => {},
    removeListeners: () => {},
  },
}));

import DaakShare from '@daak/rn-share';
import { consumePendingInbox, pickFiles, presentShare } from './share';

const native = vi.mocked(DaakShare);

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
});
