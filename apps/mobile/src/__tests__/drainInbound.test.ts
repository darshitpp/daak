import type { InboundShareItem } from '@daak/platform';
import { consumeIntentSends, consumePendingShare } from '@daak/platform';
import { fakeEngine } from '@daak/ui';
import { drainIntentSends, drainInbound, sendIntentItems } from '../bootstrap';

jest.mock('@daak/platform', () => {
  // bootstrap builds the engine at import time, so the mock has to answer
  // createEngine too, not just consumePendingShare.
  const { fakeEngine: real } = require('@daak/ui');
  return {
    createEngine: () => real(),
    consumePendingShare: jest.fn(),
    consumeIntentSends: jest.fn(async () => []),
  };
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
    const id = engine.devices().then((d) => d[0].deviceId);
    const send = jest.spyOn(engine, 'send');
    await sendIntentItems(engine, [
      { kind: 'text', text: 'hello daak' },
      { kind: 'file', path: '/data/share-inbox/1-a.png', name: '1-a.png' },
      { kind: 'intent-send', deviceId: await id, text: 'hi' },
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ peerDeviceId: await id, text: 'hi' });
  });

  // R25. ShareTargetActivity is android:exported=true, so ANY app on the device
  // can start it with daak.target_device set to an arbitrary id. Before this
  // task that only staged a row nothing read; now something sends it. An
  // unknown id is refused rather than handed to the outbox: it could never
  // resolve to a peer, and enqueueing it forever is a queue-full DoS.
  it('refuses an intent-send naming a device that is not paired', async () => {
    const engine = fakeEngine([{ deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '192.168.1.9:40001' }]);
    const send = jest.spyOn(engine, 'send');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await sendIntentItems(engine, [{ kind: 'intent-send', deviceId: 'attacker-chosen-id', text: 'hi' }]);
      expect(send).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // R31. The refusal above is the R28 security property and stays. But the
  // drain already DELETED the staged bytes by the time we decide, so a share
  // aimed at a peer paired seconds earlier -- or one racing engine.start() --
  // vanishes with no trace. Re-staging is not worth a new native write path;
  // the smallest honest mitigation is to make the drop OBSERVABLE, so the
  // owner can see a refusal happened rather than a silent loss.
  it('warns observably when it refuses an unknown target (R31)', async () => {
    const engine = fakeEngine([{ deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '1.2.3.4:1' }]);
    const send = jest.spyOn(engine, 'send');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await sendIntentItems(engine, [
        { kind: 'intent-send', deviceId: 'paired-a-second-ago', text: 'lost share' },
      ]);
      expect(send).not.toHaveBeenCalled();
      // The id must be in the message, otherwise the owner cannot act on it.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('paired-a-second-ago'));
    } finally {
      warn.mockRestore();
    }
  });

  // A known peer must NOT be noisy -- the warning is the drop signal, and a
  // warning on every good send would train the owner to ignore it.
  it('stays silent for a known target', async () => {
    const id = 'aa'.repeat(16);
    const engine = fakeEngine([{ deviceId: id, name: 'Pixel 9', addr: '1.2.3.4:1' }]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await sendIntentItems(engine, [{ kind: 'intent-send', deviceId: id, text: 'hi' }]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('sends when the target IS a known peer', async () => {
    const id = 'aa'.repeat(16);
    const engine = fakeEngine([{ deviceId: id, name: 'Pixel 9', addr: '192.168.1.9:40001' }]);
    const send = jest.spyOn(engine, 'send');
    await sendIntentItems(engine, [{ kind: 'intent-send', deviceId: id, text: 'hi' }]);
    expect(send).toHaveBeenCalledWith({ peerDeviceId: id, text: 'hi' });
  });

  // One refusal or one rejected send must not abandon the rest of the batch:
  // these are already-deleted-on-drain items, so dropping them loses the share.
  it('keeps going after a failed send', async () => {
    const id = 'aa'.repeat(16);
    const engine = fakeEngine([{ deviceId: id, name: 'Pixel 9', addr: '192.168.1.9:40001' }]);
    const send = jest.spyOn(engine, 'send').mockRejectedValueOnce(new Error('outbox full'));
    await sendIntentItems(engine, [
      { kind: 'intent-send', deviceId: id, text: 'first' },
      { kind: 'intent-send', deviceId: id, text: 'second' },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('drainIntentSends', () => {
  const consume = jest.mocked(consumeIntentSends);

  it('never touches the all-or-nothing text/file drain (R25)', async () => {
    consume.mockResolvedValueOnce([{ kind: 'intent-send', deviceId: 'aa', text: 'hi' }]);
    const engine = fakeEngine([{ deviceId: 'aa', name: 'Pixel 9', addr: '1.2.3.4:1' }]);
    const send = jest.spyOn(engine, 'send');
    await drainIntentSends(engine);
    // A text/file batch staged by Task 6 must still be on disk after this. The
    // only proof available here is that the other native drain is never called;
    // the dir partition itself is pinned in packages/platform (inbound.test.ts).
    expect(consume).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ peerDeviceId: 'aa', text: 'hi' });
  });

  it('stays quiet when nothing was staged', async () => {
    consume.mockResolvedValueOnce([]);
    const engine = fakeEngine();
    const send = jest.spyOn(engine, 'send');
    await drainIntentSends(engine);
    expect(send).not.toHaveBeenCalled();
  });
});
