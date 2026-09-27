import type { InboundShareItem } from '@daak/platform';
import { consumePendingShare } from '@daak/platform';
import { fakeEngine } from '@daak/ui';
import { drainInbound, sendIntentItems } from '../bootstrap';

jest.mock('@daak/platform', () => {
  // bootstrap builds the engine at import time, so the mock has to answer
  // createEngine too, not just consumePendingShare.
  const { fakeEngine: real } = require('@daak/ui');
  return { createEngine: () => real(), consumePendingShare: jest.fn() };
});

const consume = jest.mocked(consumePendingShare);

describe('drainInbound', () => {
  it('stays quiet when the native side staged nothing', async () => {
    consume.mockResolvedValueOnce([]);
    const onItems = jest.fn();
    await drainInbound(onItems);
    expect(onItems).not.toHaveBeenCalled();
  });

  it('hands staged items through unchanged (R7 union, no rewrite)', async () => {
    const items: InboundShareItem[] = [
      { kind: 'text', text: 'hello daak' },
      { kind: 'file', path: '/data/share-inbox/1-a.png', name: '1-a.png', mime: 'image/png' },
      { kind: 'intent-send', deviceId: 'abc', text: 'hi' },
    ];
    consume.mockResolvedValueOnce(items);
    const onItems = jest.fn();
    await drainInbound(onItems);
    expect(onItems).toHaveBeenCalledWith(items);
  });

  // R22 compile-time pin. The return type MUST be annotated: with the type left
  // off, the callback is (a) => any and a switch with a missing case still
  // compiles, so the exhaustiveness this asserts would be a lie.
  it('type-checks every arm of the frozen union', () => {
    const arms: InboundShareItem[] = [
      { kind: 'text', text: 'hello' },
      { kind: 'file', path: '/tmp/b.png', name: 'b.png' },
      { kind: 'file', path: '/tmp/c.bin', name: 'c.bin', mime: 'application/octet-stream' },
      { kind: 'intent-send', deviceId: 'aa11' },
      { kind: 'intent-send', deviceId: 'aa11', text: 'yo' },
    ];
    // Adding a 4th arm without a case here is a type error, which is the point.
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

describe('sendIntentItems', () => {
  it('sends only intent-send items and leaves text/file for the outbox', async () => {
    const engine = fakeEngine();
    const send = jest.spyOn(engine, 'send');
    await sendIntentItems(engine, [
      { kind: 'text', text: 'hello daak' },
      { kind: 'file', path: '/data/share-inbox/1-a.png', name: '1-a.png' },
      { kind: 'intent-send', deviceId: 'abc', text: 'hi' },
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ peerDeviceId: 'abc', text: 'hi' });
  });
});
