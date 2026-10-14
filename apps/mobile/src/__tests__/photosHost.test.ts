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
