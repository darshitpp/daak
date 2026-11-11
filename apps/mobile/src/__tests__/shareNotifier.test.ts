import type { InboxEntry } from '@daak/core';
import { notifyReceived } from '@daak/platform';
import { onReceived, resetShareNotifierForTests } from '../shareNotifier';

jest.mock('@daak/platform', () => ({ notifyReceived: jest.fn(async () => {}) }));

const post = jest.mocked(notifyReceived);
const SHARE = 'ab'.repeat(16);

function entry(over: Partial<InboxEntry> = {}): InboxEntry {
  return {
    payloadId: 'p',
    transferId: 't',
    peerDeviceId: 'peer1',
    kind: 'media',
    itemCount: 1,
    summary: 'a.jpg',
    receivedAt: 1,
    savedPaths: ['/x/a.jpg'],
    ...over,
  };
}
const tagged = (k: number, m: number, over: Partial<InboxEntry> = {}) =>
  entry({ share: SHARE, batch: `${k}/${m}`, ...over });
const opts = (i: number) => post.mock.calls[i][2];
const body = (i: number) => post.mock.calls[i][1]?.body;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  post.mockImplementation(async () => {});
  resetShareNotifierForTests();
});
afterEach(() => jest.useRealTimers());

describe('onReceived', () => {
  it('no tag posts one notification with sound, as today', async () => {
    const e = entry();
    await onReceived(e, 1, 0, { text: null });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(e, null);
  });

  it('m 1 posts one notification with sound', async () => {
    const e = tagged(1, 1);
    await onReceived(e, 1, 0, { text: null });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(e, null);
  });

  it('batches 1/3 and 2/3 post a silent notification with a running count under the same key', async () => {
    await onReceived(tagged(1, 3), 2, 0, { deviceName: 'Pixel' });
    await onReceived(tagged(2, 3), 3, 1, { deviceName: 'Pixel' });
    expect(post).toHaveBeenCalledTimes(2);
    expect(opts(0)).toEqual({ key: `share:peer1:${SHARE}`, silent: true });
    expect(opts(1)).toEqual({ key: `share:peer1:${SHARE}`, silent: true });
    expect(body(0)).toBe('Received 2 files from Pixel');
    expect(body(1)).toBe('Received 5 files from Pixel');
  });

  it('the last batch posts once with sound and clears the state', async () => {
    await onReceived(tagged(1, 2), 1, 0);
    await onReceived(tagged(2, 2), 1, 1);
    expect(post).toHaveBeenCalledTimes(2);
    expect(opts(1)?.silent).toBe(false);
    // The share starts again from zero.
    await onReceived(tagged(1, 2), 4, 2);
    expect(body(2)).toContain('Received 4 files');
  });

  it('batches that arrive out of order complete after the 3rd distinct k', async () => {
    await onReceived(tagged(3, 3), 1, 0);
    await onReceived(tagged(1, 3), 1, 1);
    expect(opts(1)?.silent).toBe(true);
    await onReceived(tagged(2, 3), 1, 2);
    expect(opts(2)?.silent).toBe(false);
  });

  it('m comes from the first batch; a later batch with another m is ignored', async () => {
    await onReceived(tagged(1, 3), 1, 0);
    await onReceived(tagged(2, 2), 1, 1);
    expect(post).toHaveBeenCalledTimes(1);
    await onReceived(tagged(2, 3), 1, 2);
    await onReceived(tagged(3, 3), 1, 3);
    expect(opts(2)?.silent).toBe(false);
    expect(body(2)).toContain('Received 3 files');
  });

  it('a repeated k adds no count and posts nothing', async () => {
    await onReceived(tagged(1, 3), 2, 0);
    await onReceived(tagged(1, 3), 9, 1);
    expect(post).toHaveBeenCalledTimes(1);
    await onReceived(tagged(2, 3), 1, 2);
    expect(body(1)).toContain('Received 3 files');
  });

  it('the same share from two peers is two states', async () => {
    await onReceived(tagged(1, 2, { peerDeviceId: 'a' }), 1, 0);
    await onReceived(tagged(1, 2, { peerDeviceId: 'b' }), 1, 0);
    expect(opts(0)?.key).toBe(`share:a:${SHARE}`);
    expect(opts(1)?.key).toBe(`share:b:${SHARE}`);
    await onReceived(tagged(2, 2, { peerDeviceId: 'a' }), 1, 1);
    expect(opts(2)?.silent).toBe(false);
    expect(body(2)).toContain('Received 2 files');
  });

  it('at most 32 open shares and the oldest is dropped', async () => {
    const id = (n: number) => n.toString(16).padStart(32, '0');
    for (let n = 0; n < 33; n += 1) await onReceived(tagged(1, 2, { share: id(n) }), 1, 0);
    expect(post).toHaveBeenCalledTimes(33);
    expect(jest.getTimerCount()).toBe(32);
    // The oldest share lost its state, so its batch 2 counts as a new share.
    await onReceived(tagged(2, 2, { share: id(0) }), 1, 1);
    expect(body(33)).toContain('Received 1 file from');
    // A kept share still holds its count.
    await onReceived(tagged(2, 2, { share: id(5) }), 1, 1);
    expect(body(34)).toContain('Received 2 files');
  });

  it('a missing last batch plays the sound after 3 minutes', async () => {
    await onReceived(tagged(1, 3), 2, 0, { deviceName: 'Pixel' });
    await jest.advanceTimersByTimeAsync(3 * 60_000 - 1);
    expect(post).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(post).toHaveBeenCalledTimes(2);
    expect(opts(1)).toEqual({ key: `share:peer1:${SHARE}`, silent: false });
    expect(body(1)).toBe('Received 2 files from Pixel');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('the timer is cleared when the share completes', async () => {
    await onReceived(tagged(1, 2), 1, 0);
    expect(jest.getTimerCount()).toBe(1);
    await onReceived(tagged(2, 2), 1, 1);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(4 * 60_000);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('a second sound for one peer within 10 seconds is silent', async () => {
    const done = async (share: string, now: number) => {
      await onReceived(tagged(1, 2, { share }), 1, now);
      await onReceived(tagged(2, 2, { share }), 1, now);
    };
    await done('aa'.repeat(16), 1_000);
    await done('bb'.repeat(16), 5_000);
    await done('cc'.repeat(16), 20_000);
    expect([1, 3, 5].map((i) => opts(i)?.silent)).toEqual([false, true, false]);
  });

  it('the count comes from savedCount and not from the tag', async () => {
    await onReceived(tagged(1, 9999), 2, 0);
    expect(body(0)).toContain('Received 2 files');
  });

  it('a rejected post leaves no growing state', async () => {
    post.mockRejectedValue(new Error('no'));
    await expect(onReceived(tagged(1, 2), 1, 0)).resolves.toBeUndefined();
    await expect(onReceived(tagged(2, 2), 1, 1)).resolves.toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
    await onReceived(tagged(1, 2, { share: 'cd'.repeat(16) }), 1, 2);
    await jest.advanceTimersByTimeAsync(3 * 60_000);
    expect(jest.getTimerCount()).toBe(0);
  });
});
