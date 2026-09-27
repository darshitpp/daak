import { describe, expect, it, vi } from 'vitest';
import { PAIRING_BUNDLE_BYTE_CEILING, PAIRING_QR_SIZE } from './qr';

vi.mock('@daak/rn-qrscanner', () => ({
  default: {
    scan: vi.fn(async () => '{"device_id":"aa"}'),
    generate: vi.fn(async () => 'data:image/png;base64,AAAA'),
  },
}));

import NativeDaakQrScanner from '@daak/rn-qrscanner';
import { generateQr, scanQr } from './qr';

const native = vi.mocked(NativeDaakQrScanner);

describe('qr facade', () => {
  it('forwards the scanned payload string', async () => {
    await expect(scanQr()).resolves.toBe('{"device_id":"aa"}');
    expect(native.scan).toHaveBeenCalledTimes(1);
  });

  // The size argument is part of the native contract: an omitted size must not
  // silently arrive as undefined on the other side of the bridge.
  it('forwards the payload and the size argument to the native generator', async () => {
    await generateQr('{"v":1}', 640);
    expect(native.generate).toHaveBeenCalledWith('{"v":1}', 640);
  });

  it('defaults the size to the named shared constant (512)', async () => {
    await generateQr('{"v":1}');
    expect(PAIRING_QR_SIZE).toBe(512);
    expect(native.generate).toHaveBeenCalledWith('{"v":1}', PAIRING_QR_SIZE);
  });
});

describe('the QR size and capacity contract', () => {
  // The pairing bundle is {cbor, name, device_id} where cbor is hex of ~220-260
  // CBOR bytes, so the JSON payload measures ~480-560 chars. iOS renders at
  // level M and Android is now pinned to M too (see qrScanner.test.ts), so the
  // shared ceiling is the v40-M capacity of 2331 bytes. Any bundle that grows
  // past it must fail legibly here, not with a bare native E_ENCODE.
  it('pins the v40-M ceiling and rejects an oversized payload before the native call', async () => {
    expect(PAIRING_BUNDLE_BYTE_CEILING).toBe(2331);
    const oversized = 'x'.repeat(PAIRING_BUNDLE_BYTE_CEILING + 1);
    native.generate.mockClear();
    await expect(generateQr(oversized)).rejects.toThrow(/too large/);
    expect(native.generate).not.toHaveBeenCalled();
  });
});
