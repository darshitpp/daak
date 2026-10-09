import type { DaakEngine } from '@daak/core';
import { generateQr, PAIRING_QR_SIZE, pairingBundle, scanQr } from '@daak/platform';

/**
 * The app-level halves of QR pairing. R90: they live HERE, not in App.tsx,
 * and the join half takes the engine as a parameter -- the same shape as
 * drainIntentSends(engine, ...) in bootstrap.ts. Neither half subscribes to
 * engine events: the ONE engine.on in bootstrap.ts already publishes the peer
 * list on pairing.done (R42/R91), and SAS display is the caller's job (the
 * pairing screen's Task-12 half).
 */

/**
 * Host half: fetch the FFI pairing bundle and render it as a scannable QR.
 * Returns both the data URI for the screen and the raw bundle, so the host
 * can show its own SAS when the joiner confirms.
 */
export async function hostPairingQr(): Promise<{ uri: string; bundle: string }> {
  const bundle = await withDeadline(pairingBundle(), 'the pairing bundle');
  const uri = await withDeadline(generateQr(bundle, PAIRING_QR_SIZE), 'the QR code');
  return { uri, bundle };
}

/**
 * A native bridge that never settles its promise reaches the user as NOTHING:
 * no QR, no error, a button that looks dead. Every rejecting path already
 * shows a note, so the only unexplained failure is the one that never arrives.
 * Bound the wait and name it, so "Show QR" either works or says why.
 *
 * Generous on purpose: a cold process can take a moment, and this catches a
 * promise that NEVER settles, not a slow one.
 */
const HOST_QR_DEADLINE_MS = 10_000;

export function withDeadline<T>(
  promise: Promise<T>,
  what: string,
  ms = HOST_QR_DEADLINE_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`daak: ${what} did not finish`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Host half, step two (C2, second review): arm the accept slot from the QR the
 * host is already showing. NO camera and NO scanned bundle.
 *
 * The QR flow is asymmetric -- only the JOINER scans, so only the joiner ever
 * holds the host's bundle, and the sanctioned flow never gives the host the
 * joiner's. The previous version of this function scanned for a joiner bundle
 * that no real device can display, which is why host-side pairing was
 * unreachable no matter what the tests said. The engine now learns the peer's
 * identity in-band and verifies it in the Noise XX handshake; the user
 * comparing the two SAS values is what binds it to a human.
 *
 * One-shot and re-armable: the accept slot is consumed by the connection it
 * accepts, and arming again simply replaces whatever is pending.
 */
export async function armHostPairing(engine: DaakEngine): Promise<void> {
  await engine.armHostPairing();
}

/**
 * Join half: scan a host QR, validate the bundle, and hand the CBOR hex to
 * engine.pair. R88: the secret is parsed.cbor (hex), never the whole scanned
 * payload; InProcessEngine.pair resolves the device id to an ip:port itself
 * and throws for an unknown device, so a bundle that names a peer we have not
 * discovered rejects here with the engine's error.
 */
export async function joinWithScan(engine: DaakEngine): Promise<{ sas: string }> {
  const scanned = await scanQr();
  const { deviceId, cbor, addr } = parsePairingPayload(scanned);
  return engine.pair(deviceId, 'qr', cbor, addr);
}

/**
 * Validates the scanned pairing-bundle JSON the FFI produces
 * (crates/daak-ffi/src/lib.rs pairing_bundle_json: {cbor, name, device_id}).
 * Pure for the tests. The device_id is 32 hex chars (16 bytes) -- see
 * daak-core's crypto/identity.rs -- and cbor is the bundle CBOR as hex, which
 * engine.pair's own hexToBytes decodes. No hex decoder is re-implemented here.
 */
export function parsePairingPayload(scanned: string): {
  deviceId: string;
  cbor: string;
  addr?: string;
} {
  let json: unknown;
  try {
    json = JSON.parse(scanned);
  } catch {
    throw new Error('daak: scanned QR is not a pairing bundle (bad JSON)');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('daak: scanned QR is not a pairing bundle');
  }
  const { cbor, device_id: deviceId } = json as { cbor?: unknown; device_id?: unknown };
  if (typeof deviceId !== 'string' || !/^[0-9a-fA-F]{32}$/.test(deviceId)) {
    throw new Error('daak: pairing bundle has no valid 32-hex device_id');
  }
  if (typeof cbor !== 'string' || cbor.length === 0) {
    throw new Error('daak: pairing bundle has no cbor');
  }
  // `addr` is OPTIONAL. The host includes it when it knows a dialable address,
  // which is what makes pairing reachable on a network mDNS does not cross
  // (measured: a NAT-ed Android emulator saw zero peers while unicast reached
  // the host). A bundle without the key is an older link or a host bound to
  // loopback, and both keep working through discovery.
  //
  // A MALFORMED one is a hard reject. The joiner dials this string directly, so
  // a typo passed through would reach the dialer as something the engine cannot
  // parse -- a worse failure than no address at all.
  const addr = (json as { addr?: unknown }).addr;
  if (addr === undefined || addr === null) return { deviceId, cbor };
  if (typeof addr !== 'string' || !isDialable(addr)) {
    throw new Error('daak: pairing bundle has a malformed addr');
  }
  return { deviceId, cbor, addr };
}

/** `host:port` with a numeric port. No `URL`: Hermes throws on it. */
function isDialable(s: string): boolean {
  const at = s.lastIndexOf(':');
  if (at <= 0 || at === s.length - 1) return false;
  const port = s.slice(at + 1);
  if (!/^\d{1,5}$/.test(port)) return false;
  const n = Number(port);
  return n >= 1 && n <= 65535 && !s.slice(0, at).includes(':');
}
