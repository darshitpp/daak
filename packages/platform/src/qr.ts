import NativeDaakQrScanner from '@daak/rn-qrscanner';

/**
 * The QR size + capacity contract for pairing, shared by every caller.
 *
 * Size: PAIRING_QR_SIZE is the named default both native sides render at
 * (iOS scales its CIQRCodeGenerator output by size/32; Android renders the
 * bitmap at exactly size px).
 *
 * Error-correction level: pinned to M on BOTH platforms (iOS sets it
 * explicitly; Android now passes ERROR_CORRECTION=M instead of zxing's default
 * L) so the two sides share one capacity ceiling. See
 * apps/mobile/src/__tests__/qrScanner.test.ts, which fails if either side
 * drifts.
 *
 * Ceiling: the pairing bundle is {cbor, name, device_id} where cbor is hex of
 * ~220-260 CBOR bytes, so the JSON payload measures ~480-560 chars. v40-M
 * holds 2331 bytes, about 4x headroom. payload.length is chars, and this JSON
 * is pure ASCII, so chars == bytes here; the guard below makes an oversized
 * bundle fail legibly instead of with a bare native E_ENCODE.
 */
export const PAIRING_QR_SIZE = 512;
export const PAIRING_BUNDLE_BYTE_CEILING = 2331;

/**
 * Presents the camera and resolves with the decoded QR payload string.
 * Caller-owned: the returned string is a pairing bundle JSON, and parsing it
 * is the caller's job (see apps/mobile/src/pairing.ts).
 */
export async function scanQr(): Promise<string> {
  return NativeDaakQrScanner.scan();
}

/**
 * Renders a payload to a data:image/png;base64,... QR URI at the given size.
 * The host half of pairing renders the pairing bundle here.
 */
export async function generateQr(payload: string, size = PAIRING_QR_SIZE): Promise<string> {
  if (payload.length > PAIRING_BUNDLE_BYTE_CEILING) {
    throw new Error(
      'daak: pairing payload too large for a scannable QR: ' +
        payload.length +
        ' chars > ' +
        PAIRING_BUNDLE_BYTE_CEILING +
        ' (v40-M)');
  }
  return NativeDaakQrScanner.generate(payload, size);
}
