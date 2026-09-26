import type { Spec as NativeDaak } from '../NativeDaak';
import type { DaakEngine, DaakEvent, DeviceInfo, InboxEntry, SendRequest } from './types';

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
    // pair_with takes an ip:port, not a device id (R13), so resolve it from the
    // known devices. The `secret` is the bundle CBOR as hex (qr) or the manual
    // pairing code; both cross the FFI boundary as bytes.
    const device = (await this.devices()).find((d) => d.deviceId === deviceId);
    if (!device) throw new Error(`unknown device ${deviceId}`);
    void mode;
    const { sas } = JSON.parse(await this.native.pairWith(device.addr, hexToBytes(secret ?? '')));
    return { sas };
  }

  async send(req: SendRequest): Promise<{ transferId: string; queued: boolean }> {
    // Both native sends go through the outbox (R7), so the id comes back
    // immediately whether or not the peer is online.
    if (req.text && (req.files?.length ?? 0) === 0) {
      return { transferId: await this.native.sendText(req.peerDeviceId, req.text), queued: true };
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
      // A Rust thread cannot reject a JS promise, so a malformed event is the
      // one place this can fail: drop it rather than crash the app.
      try {
        const e = JSON.parse(raw) as DaakEvent;
        if (typeof e?.type === 'string') cb(e);
      } catch {
        // unparseable event
      }
    });
  }
}
