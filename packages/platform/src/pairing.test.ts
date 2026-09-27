import { describe, expect, it, vi } from 'vitest';

// The real @daak/core barrel executes TurboModuleRegistry.getEnforcing('Daak')
// at module-eval, which is a no-op under the react-native stub but never
// answers pairingBundle. The facade is a forwarder; the mock pins what it
// forwards, untouched.
vi.mock('@daak/core', () => ({
  NativeDaak: {
    pairingBundle: vi.fn(async () => '{"cbor":"aa","name":"me","device_id":"bb"}'),
  },
}));

import { pairingBundle } from './pairing';

describe('pairing facade', () => {
  it('forwards the native pairing bundle unchanged', async () => {
    await expect(pairingBundle()).resolves.toBe(
      '{"cbor":"aa","name":"me","device_id":"bb"}',
    );
  });
});
