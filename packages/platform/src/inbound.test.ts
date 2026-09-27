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
import { consumePendingShare, type InboundShareItem } from './inbound';

const native = vi.mocked(DaakShare);

describe('consumePendingShare', () => {
  it('parses both text and file items', async () => {
    const items = await consumePendingShare();
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ kind: 'text', text: 'hello' });
    // toEqual, not toMatchObject: a dropped `path` would survive toMatchObject
    // and the caller would be handed an unopenable file.
    expect(items[1]).toEqual({ kind: 'file', path: 'a/b.png', name: 'b.png' });
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

  // R7 compile-time pin. Two halves, and BOTH are load-bearing:
  //  - the typed literal list, so a renamed or dropped union arm is a
  //    TS2322/TS2345 at the literal rather than a silent runtime shape change;
  //  - the `(a): string =>` annotation on the map callback, which is what makes
  //    the switch exhaustive. Without it the callback infers `string |
  //    undefined`, so a DROPPED case and a 4th ADDED arm both still compile.
  //    With it, either one is a type error.
  it('type-checks every arm of the frozen union', () => {
    const arms: InboundShareItem[] = [
      { kind: 'text', text: 'hello' },
      { kind: 'file', path: '/tmp/b.png', name: 'b.png' },
      { kind: 'file', path: '/tmp/c.bin', name: 'c.bin', mime: 'application/octet-stream' },
      { kind: 'intent-send', deviceId: 'aa11' },
      { kind: 'intent-send', deviceId: 'aa11', text: 'yo' },
    ];
    const kinds = arms.map((a): string => {
      switch (a.kind) {
        case 'text':
          return a.text;
        case 'file':
          return `${a.name}:${a.path}:${a.mime ?? ''}`;
        case 'intent-send':
          return `${a.deviceId}:${a.text ?? ''}`;
      }
    });
    expect(kinds).toHaveLength(5);
  });
});
