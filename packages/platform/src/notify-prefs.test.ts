import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@daak/rn-securestore', () => ({
  default: { get: vi.fn(), set: vi.fn(async () => true), remove: vi.fn(async () => true) },
}));

import NativeDaakSecureStore from '@daak/rn-securestore';
import { DEFAULT_NOTIFY_PREFS, loadNotifyPrefs, saveNotifyPrefs } from './notify-prefs';

const native = vi.mocked(NativeDaakSecureStore);

beforeEach(() => {
  vi.clearAllMocks();
  native.set.mockResolvedValue(true);
});

describe('notify prefs', () => {
  it('loads the arrival switch on when the store is empty', async () => {
    native.get.mockResolvedValue(null);
    await expect(loadNotifyPrefs()).resolves.toEqual({ arrival: true });
    expect(DEFAULT_NOTIFY_PREFS).toEqual({ arrival: true });
  });

  it('treats an undefined bridge answer like an empty store', async () => {
    native.get.mockResolvedValue(undefined as unknown as null);
    await expect(loadNotifyPrefs()).resolves.toEqual({ arrival: true });
  });

  it('round-trips a saved value', async () => {
    await saveNotifyPrefs({ arrival: false });
    expect(native.set).toHaveBeenCalledWith('notify.prefs.v1', JSON.stringify({ arrival: false }));
    native.get.mockResolvedValue(JSON.stringify({ arrival: false }));
    await expect(loadNotifyPrefs()).resolves.toEqual({ arrival: false });
  });

  // A missing field defaults to TRUE. The onboarding flags default to false.
  // The rule is the opposite here, because the spec sets the default to on.
  it('defaults a missing or non-boolean field to on', async () => {
    native.get.mockResolvedValue(JSON.stringify({}));
    await expect(loadNotifyPrefs()).resolves.toEqual({ arrival: true });
    native.get.mockResolvedValue(JSON.stringify({ arrival: 'no' }));
    await expect(loadNotifyPrefs()).resolves.toEqual({ arrival: true });
  });

  it('ignores a field that is not part of the preferences', async () => {
    native.get.mockResolvedValue(JSON.stringify({ arrival: false, sound: false }));
    await expect(loadNotifyPrefs()).resolves.toEqual({ arrival: false });
  });

  it('falls back to the defaults for corrupt JSON and for a non-object', async () => {
    native.get.mockResolvedValue('{not json');
    await expect(loadNotifyPrefs()).resolves.toEqual({ arrival: true });
    native.get.mockResolvedValue('42');
    await expect(loadNotifyPrefs()).resolves.toEqual({ arrival: true });
    native.get.mockResolvedValue('null');
    await expect(loadNotifyPrefs()).resolves.toEqual({ arrival: true });
  });

  // The caller is the engine event handler. A locked keystore must cost the
  // user nothing worse than the default banner.
  it('does not reject when the keystore read rejects', async () => {
    native.get.mockRejectedValue(new Error('keystore locked'));
    await expect(loadNotifyPrefs()).resolves.toEqual({ arrival: true });
  });

  it('rejects a save that the keystore refuses', async () => {
    native.set.mockResolvedValue(false);
    await expect(saveNotifyPrefs({ arrival: false })).rejects.toThrow(
      'notify prefs: the keystore refused the write',
    );
  });

  it('returns a fresh object, so a caller cannot change the defaults', async () => {
    native.get.mockResolvedValue(null);
    const first = await loadNotifyPrefs();
    first.arrival = false;
    await expect(loadNotifyPrefs()).resolves.toEqual({ arrival: true });
  });
});
