import type { Spec as NativeDaak } from '../NativeDaak';
import type { DaakEngine, DaakEvent, DeviceInfo, InboxEntry, SendRequest } from './types';

/**
 * Subscribes to engine events and calls `cb` with ONE raw event JSON string.
 *
 * The channel name is exactly 'DaakEvent' (see supportedEvents() in
 * Daak.swift) and the payload is an OBJECT, { event: string } -- DaakModule.kt
 * does map.putString('event', json) and Daak.swift does
 * sendEvent(withName: 'DaakEvent', body: ['event': json]). Whoever writes the
 * production subscription factory is responsible for unwrapping .event and
 * passing the STRING here; if it forwards the object instead, JSON.parse below
 * throws on every event and the whole stream dies silently.
 */
export type EventSubscribe = (cb: (raw: string) => void) => () => void;

function hexToBytes(hex: string): number[] {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`bundle cbor must be hex: ${hex}`);
  }
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

export class InProcessEngine implements DaakEngine {
  constructor(
    private native: NativeDaak,
    private subscribe: EventSubscribe,
  ) {}

  start(): Promise<void> { return this.native.start('', 'daak', 0); }
  stop(): Promise<void> { return this.native.shutdown(); }

  async devices(): Promise<DeviceInfo[]> {
    const json = await this.native.listDevices();
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) throw new Error('listDevices did not return an array');
    return parsed as DeviceInfo[];
  }

  async pair(deviceId: string, mode: 'qr' | 'code', secret?: string): Promise<{ sas: string }> {
    // The frozen FFI surface has only pair_with(addr, bundle_cbor bytes), which
    // runs PairingBundle::from_cbor. A manual code is not a CBOR bundle, so a
    // hex decode of it would be nonsense; say so instead of failing obscurely.
    if (mode === 'code') throw new Error('manual-code pairing is not on the FFI surface yet');
    // pair_with takes an ip:port, not a device id (R13), so resolve it from the
    // known devices. The `secret` is the bundle CBOR as hex.
    const device = (await this.devices()).find((d) => d.deviceId === deviceId);
    if (!device) throw new Error(`unknown device ${deviceId}`);
    const { sas } = JSON.parse(await this.native.pairWith(device.addr, hexToBytes(secret ?? '')));
    return { sas };
  }

  async send(req: SendRequest): Promise<{ transferId: string; queued: boolean }> {
    const hasText = typeof req.text === 'string' && req.text.length > 0;
    const hasFiles = (req.files?.length ?? 0) > 0;
    if (hasText && hasFiles) throw new Error('send takes text or files, not both');
    if (!hasText && !hasFiles) throw new Error('refusing an empty send');
    // Both native sends go through the outbox (R7), so the id comes back
    // immediately whether or not the peer is online.
    // ponytail: queued is always true because the outbox returns a row id, not
    // a delivery state; widen it when the engine reports delivery.
    if (hasText) {
      return { transferId: await this.native.sendText(req.peerDeviceId, req.text as string), queued: true };
    }
    return { transferId: await this.native.sendFiles(req.peerDeviceId, req.files ?? []), queued: true };
  }

  cancel(_: string): Promise<void> { return Promise.resolve(); }
  retry(_: string): Promise<void> { return Promise.resolve(); }
  listTransfers(): Promise<unknown[]> { return Promise.resolve([]); }
  listInbox(): Promise<InboxEntry[]> { return Promise.resolve([]); }
  setDisplayName(_: string): Promise<void> { return Promise.resolve(); }
  setPresence(_: 'online' | 'away'): Promise<void> { return Promise.resolve(); }

  on(cb: (e: DaakEvent) => void): () => void {
    return this.subscribe((raw) => {
      let e: DaakEvent | undefined;
      try {
        const parsed = JSON.parse(raw) as DaakEvent;
        if (typeof parsed?.type === 'string') e = parsed;
      } catch {
        // A Rust thread cannot reject a JS promise, so a malformed event is the
        // one place this may be dropped rather than crash the app. cb() is
        // deliberately OUTSIDE the try: a throwing consumer handler must reach
        // whoever emitted it, not disappear.
      }
      if (e) cb(e);
    });
  }
}
