import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@daak/rn-securestore', () => ({
  default: { get: vi.fn(), set: vi.fn(async () => true), remove: vi.fn(async () => true) },
}));

import NativeDaakSecureStore from '@daak/rn-securestore';
import { INITIAL_ONBOARDING, readOnboarding, writeOnboarding } from './onboarding';

const native = vi.mocked(NativeDaakSecureStore);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('onboarding state', () => {
  it('is not complete on a first launch, and asks for nothing', async () => {
    native.get.mockResolvedValue(null);
    await expect(readOnboarding()).resolves.toEqual(INITIAL_ONBOARDING);
    // Both permissions default OFF. Continue is gated on them, so a fresh
    // install renders the Permissions screen with the user's real answer
    // (nothing granted yet) rather than a switch that was silently on.
    expect(INITIAL_ONBOARDING.discovery).toBe(false);
    expect(INITIAL_ONBOARDING.alerts).toBe(false);
  });

  it('round-trips a completed onboarding through the keystore', async () => {
    native.get.mockResolvedValue(null);
    native.set.mockResolvedValue(true);
    const saved = { complete: true, name: 'Seawood Otter', discovery: true, alerts: true };
    await writeOnboarding(saved);

    // The next launch reads what was written, not what was typed before.
    native.get.mockResolvedValue(JSON.stringify(saved));
    await expect(readOnboarding()).resolves.toEqual(saved);
    expect(native.set).toHaveBeenCalledTimes(1);
  });

  // The screen has to know a user DECLINED alerts, or every launch re-asks the
  // question they already answered. A missing key is therefore not the same as
  // `alerts: false`, and neither is a missing `alerts` field in a present blob.
  it('remembers a declined permission instead of re-asking it', async () => {
    native.get.mockResolvedValue(JSON.stringify({ complete: true, discovery: true }));
    await expect(readOnboarding()).resolves.toEqual({
      complete: true,
      name: undefined,
      discovery: true,
      alerts: false,
    });
  });

  // Defaulting a missing flag to true would GRANT a permission nobody agreed
  // to and render its switch on. The prototype gates Continue on these, so the
  // permissive default would also let a user past the gate.
  it('never treats an absent flag as granted', async () => {
    native.get.mockResolvedValue(JSON.stringify({ discovery: true }));
    const state = await readOnboarding();
    expect(state.complete).toBe(false);
    expect(state.discovery).toBe(true);
    expect(state.alerts).toBe(false);
  });

  // Re-running onboarding on a merely-locked keystore is how a paired device
  // gets re-paired. A rejection must reach the caller, not flatten to false.
  it('propagates a keystore rejection instead of reporting a fresh install', async () => {
    native.get.mockRejectedValue(new Error('keychain read failed: -25308'));
    await expect(readOnboarding()).rejects.toThrow('keychain read failed');
  });

  // Refusing to launch over a garbled flag is worse than re-asking two
  // questions, and the next write repairs the blob.
  it('treats a corrupt blob as a first launch rather than refusing to launch', async () => {
    native.get.mockResolvedValue('{not json');
    await expect(readOnboarding()).resolves.toEqual(INITIAL_ONBOARDING);
  });

  it('ignores an empty stored name rather than showing a blank device name', async () => {
    native.get.mockResolvedValue(JSON.stringify({ complete: true, name: '' }));
    await expect(readOnboarding()).resolves.toMatchObject({ name: undefined });
  });
});
