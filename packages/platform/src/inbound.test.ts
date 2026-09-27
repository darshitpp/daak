import { describe, expect, it, vi } from 'vitest';

vi.mock('@daak/rn-share', () => ({
  default: {
    consumePendingInbox: vi.fn(
      async () =>
        JSON.stringify([
          { kind: 'text', text: 'hello' },
          { kind: 'file', path: 'a/b.png', name: 'b.png' },
        ]),
    ),
    present: vi.fn(),
    pickDocuments: vi.fn(),
    addListener: vi.fn(),
    removeListeners: vi.fn(),
  },
}));

import DaakShare from '@daak/rn-share';
import { consumePendingShare } from './inbound';

const native = vi.mocked(DaakShare);

describe('consumePendingShare', () => {
  it('parses both text and file items', async () => {
    const items = await consumePendingShare();
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ kind: 'text', text: 'hello' });
    expect(items[1]).toMatchObject({ kind: 'file', name: 'b.png' });
  });

  it('returns an empty array when the native payload is empty', async () => {
    native.consumePendingInbox.mockResolvedValueOnce('');
    await expect(consumePendingShare()).resolves.toEqual([]);
  });

  // A truncated batch (app killed mid-write) must not throw and must not reach
  // the engine as garbage; the extension rewrites nothing, we just drop it.
  it('returns an empty array for malformed JSON', async () => {
    native.consumePendingInbox.mockResolvedValueOnce('[{"kind":"text"');
    await expect(consumePendingShare()).resolves.toEqual([]);
  });

  it('returns an empty array when the payload is JSON but not an array', async () => {
    native.consumePendingInbox.mockResolvedValueOnce('{"kind":"text"}');
    await expect(consumePendingShare()).resolves.toEqual([]);
  });

  // R7: the intent-send arm is staged by Task 6/7 (App Intents) and must pass
  // through unchanged, so the union really has three arms.
  it('passes an intent-send item through', async () => {
    native.consumePendingInbox.mockResolvedValueOnce(
      JSON.stringify([{ kind: 'intent-send', deviceId: 'aa11', text: 'yo' }]),
    );
    await expect(consumePendingShare()).resolves.toEqual([
      { kind: 'intent-send', deviceId: 'aa11', text: 'yo' },
    ]);
  });
});
