import { describe, expect, it, vi } from 'vitest';

vi.mock('@daak/rn-share', () => ({
  default: {
    updateShortcutTargets: vi.fn(async () => {}),
    addListener: vi.fn(),
    removeListeners: vi.fn(),
  },
}));

import DaakShare from '@daak/rn-share';
import { syncShortcutTargets } from './shortcuts';

// vi.mocked, not `as any`: the brief's cast threw away the type of the thing
// under assertion, so a renamed native method would still have compiled here.
const native = vi.mocked(DaakShare);

describe('syncShortcutTargets', () => {
  it('serializes devices to the native shortcut syncer', async () => {
    await syncShortcutTargets([{ deviceId: 'aa', name: 'Pixel 9', addr: '1.2.3.4:1', online: true }]);
    expect(native.updateShortcutTargets).toHaveBeenCalledWith(
      JSON.stringify([{ deviceId: 'aa', name: 'Pixel 9' }]),
    );
  });

  // The one method is the ONLY writer of the App Group `pairedDevices` key on
  // iOS (R26), which is what DaakIntentBridge.devices() reads to answer the Siri
  // entity query. `[]` is a real answer -- "no peers" -- not a skip: skipping
  // would leave a stale peer list in the App Group and offer Siri a device that
  // has been unpaired.
  it('clears the target list when there are no peers', async () => {
    await syncShortcutTargets([]);
    expect(native.updateShortcutTargets).toHaveBeenLastCalledWith('[]');
  });

  // addr and online are deliberately dropped: the shortcut's Intent carries
  // only the device id, and a stale address baked into a long-lived shortcut
  // would outlive the peer list it came from.
  it('never leaks the address or online flag into the native payload', async () => {
    await syncShortcutTargets([{ deviceId: 'bb', name: 'iPad', addr: '10.0.0.5:1', online: false }]);
    expect(native.updateShortcutTargets).toHaveBeenLastCalledWith(
      JSON.stringify([{ deviceId: 'bb', name: 'iPad' }]),
    );
  });
});
