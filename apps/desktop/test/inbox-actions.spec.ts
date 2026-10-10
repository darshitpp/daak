import { describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted above the imports, so the mock fn must be hoisted too.
const { openFile } = vi.hoisted(() => ({ openFile: vi.fn(async () => true) }));
vi.mock('@daak/platform/src/fspaths', () => ({ openFile }));
vi.mock('@daak/rn-share/js/system-share', () => ({ shareViaSystem: vi.fn(async () => {}) }));

import { desktopInboxActions } from '../src/inbox-actions';

describe('desktopInboxActions', () => {
  it('opens a file through the native openFile verb', async () => {
    await expect(desktopInboxActions.open?.('/a/b.pdf')).resolves.toBe(true);
    expect(openFile).toHaveBeenCalledWith('/a/b.pdf');
  });

  it('still supplies no copy verb, because the clipboard pod is not linked', () => {
    expect(desktopInboxActions.copy).toBeUndefined();
  });
});

