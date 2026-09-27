import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxEntry } from '@daak/core';
import type { Spec as ClipboardSpec } from '@daak/rn-clipboard';
import { routeInboxEntry } from './receive';

const entry = (over: Partial<InboxEntry> = {}): InboxEntry => ({
  payloadId: 'p1',
  transferId: 't1',
  peerDeviceId: 'd1',
  kind: 'text',
  itemCount: 1,
  summary: 'hello from the other device',
  receivedAt: 1_700_000_000_000,
  savedPaths: null,
  ...over,
});

// A TYPED fake, built from the module's own Spec -- never `as any`. If the
// clipboard spec loses a method this fake is a compile error, which is the
// point: the dep is the same contract the real TurboModule satisfies.
function fakeClipboard(): { spec: ClipboardSpec; setString: ReturnType<typeof vi.fn> } {
  // The mock must satisfy the Spec's real signature (setString RESOLVES
  // boolean), not a looser one, or the fake would stop being a check that the
  // dep matches the module contract. getString is implemented for real so
  // this is a genuine Spec value, not a cast.
  const setString = vi.fn(async (_text: string) => true);
  const getString = vi.fn(async () => '');
  const spec: ClipboardSpec = { setString, getString };
  return { spec, setString };
}

describe('routeInboxEntry', () => {
  let clipboard: ReturnType<typeof fakeClipboard>;

  beforeEach(() => {
    clipboard = fakeClipboard();
  });

  // crates/daak-core/src/engine.rs:701-705: for PayloadKind::Text the inbox
  // summary IS the first item's text, so summary is the whole payload here.
  it('copies the summary to the clipboard for a text entry', async () => {
    await routeInboxEntry(entry(), { clipboard: clipboard.spec });
    expect(clipboard.setString).toHaveBeenCalledWith('hello from the other device');
  });

  it('copies an empty text body without throwing', async () => {
    await expect(
      routeInboxEntry(entry({ summary: '' }), { clipboard: clipboard.spec }),
    ).resolves.toBeUndefined();
    expect(clipboard.setString).toHaveBeenCalledWith('');
  });

  // Reveal is unwired on both platforms (R41), so there is NOTHING honest for a
  // file entry to do. Throwing here would take down the engine.on handler and
  // with it the notifyReceived sitting next to it in the same subscription.
  it('returns early for a non-text entry without touching the clipboard', async () => {
    const files = entry({ kind: 'batch', itemCount: 3, summary: '3 file(s)' });
    await expect(routeInboxEntry(files, { clipboard: clipboard.spec })).resolves.toBeUndefined();
    expect(clipboard.setString).not.toHaveBeenCalled();
  });

  it('returns early for a media entry too', async () => {
    await expect(
      routeInboxEntry(entry({ kind: 'media', summary: '1 file(s)' }), { clipboard: clipboard.spec }),
    ).resolves.toBeUndefined();
    expect(clipboard.setString).not.toHaveBeenCalled();
  });

  // The clipboard is a hard dependency, not an optional one: a missing module
  // is a registration bug that must be loud, and it still must not throw out of
  // the engine.on handler (an unhandled rejection there kills the subscription).
  it('warns rather than throwing when the clipboard write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    clipboard.setString.mockRejectedValueOnce(new Error('clipboard unavailable'));
    await expect(routeInboxEntry(entry(), { clipboard: clipboard.spec })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
