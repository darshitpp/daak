import { mockPlatformHost } from '../testPlatformMock';
import { askForPhotosIfUndetermined } from '../photosHost';

jest.mock('@daak/platform', () => mockPlatformHost());

function host(status: () => Promise<string>, request = jest.fn(async () => true)) {
  return { status: status as never, request };
}

describe('askForPhotosIfUndetermined', () => {
  it('asks once when the OS has not been asked', async () => {
    const h = host(async () => 'undetermined');
    await askForPhotosIfUndetermined(h);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it.each(['granted', 'denied', 'unavailable'])('does not ask when the status is %s', async (s) => {
    const h = host(async () => s);
    await askForPhotosIfUndetermined(h);
    expect(h.request).not.toHaveBeenCalled();
  });

  it('does not reject when status rejects', async () => {
    const h = host(async () => {
      throw new Error('status failed');
    });
    await expect(askForPhotosIfUndetermined(h)).resolves.toBeUndefined();
    expect(h.request).not.toHaveBeenCalled();
  });

  it('does not reject when request rejects', async () => {
    const h = host(
      async () => 'undetermined',
      jest.fn(async () => {
        throw new Error('request failed');
      }),
    );
    await expect(askForPhotosIfUndetermined(h)).resolves.toBeUndefined();
    expect(h.request).toHaveBeenCalledTimes(1);
  });
});

describe('photosHost by platform', () => {
  // The module reads Platform when it loads, so each case loads a fresh copy.
  function load(os: string, version: string | number) {
    let mod: typeof import('../photosHost') | undefined;
    jest.isolateModules(() => {
      const { Platform: P } = require('react-native');
      Object.defineProperty(P, 'OS', { configurable: true, get: () => os });
      Object.defineProperty(P, 'Version', { configurable: true, get: () => version });
      mod = require('../photosHost');
    });
    return mod!;
  }

  it.each([26, 27, 28, '28'])('is undefined on Android API %s', (v) => {
    expect(load('android', v).photosHost).toBeUndefined();
  });

  it.each([29, 35, '29'])('is defined on Android API %s', (v) => {
    expect(load('android', v).photosHost?.destination).toBe('Gallery');
  });

  it('is defined on iOS', () => {
    expect(load('ios', '18.0').photosHost?.destination).toBe('Photos app');
  });

  it('asks for nothing and does not throw when the host is undefined', async () => {
    const { askForPhotosIfUndetermined: ask } = load('android', 28);
    await expect(ask()).resolves.toBeUndefined();
  });
});
