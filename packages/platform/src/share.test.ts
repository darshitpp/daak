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
import { pickFiles, presentShare } from './share';

const native = vi.mocked(DaakShare);

describe('share facade', () => {
  it('forwards text and urls to the native presenter', async () => {
    await presentShare({ text: 'hi', urls: ['/tmp/a.pdf'], mime: 'application/pdf' });
    expect(native.present).toHaveBeenCalledWith('hi', ['/tmp/a.pdf'], 'application/pdf');
  });

  it('defaults mime to */* when none is given', async () => {
    await presentShare({ urls: ['/tmp/a.pdf'] });
    expect(native.present).toHaveBeenLastCalledWith('', ['/tmp/a.pdf'], '*/*');
  });

  it('exposes the document picker', async () => {
    await expect(pickFiles(true)).resolves.toEqual(['/tmp/a.pdf']);
  });
});
