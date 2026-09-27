import { NativeDaak } from '@daak/core';

/**
 * The host-side pairing bundle JSON -- {cbor, name, device_id} -- straight
 * from the FFI (crates/daak-ffi/src/lib.rs pairing_bundle_json). This is the
 * payload the host renders into the QR. Parsing it is the caller's job:
 * apps/mobile/src/pairing.ts turns it into a QR, and the joiner's scanned
 * result is validated there too (R88: engine.pair takes the cbor hex, never
 * the whole payload).
 */
export async function pairingBundle(): Promise<string> {
  return NativeDaak.pairingBundle();
}
