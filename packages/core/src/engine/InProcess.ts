import type { Spec as NativeDaak } from '../NativeDaak';
import type {
  CodePairingStatus,
  DaakEngine,
  DaakEvent,
  DeviceInfo,
  InboxEntry,
  SendRequest,
  QuarantineReport,
  SelfProfile,
  ThreadPage,
  TransferFilter,
  TransferSummary,
} from './types';

/**
 * Subscribes to engine events and calls `cb` with ONE raw event JSON string.
 *
 * The channel name is exactly 'DaakEvent' (see supportedEvents() in
 * Daak.swift) and the payload is an OBJECT, { event: string } -- DaakModule.kt
 * does map.putString('event', json) and Daak.swift does
 * sendEvent(withName: 'DaakEvent', body: ['event': json]). on() accepts either
 * shape so a factory cannot kill the stream by forwarding the envelope.
 */
export type EventSubscribe = (cb: (raw: string | { event: string }) => void) => () => void;

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

  async pair(deviceId: string, mode: 'qr' | 'code', secret?: string, addr?: string): Promise<{ sas: string }> {
    // pair_with and pair_with_code each take an ip:port, not a device id (R13),
    // so an address has to come from somewhere. A pairing link can NAME one;
    // without it the address is resolved from discovery, which fails on any
    // network mDNS does not cross (measured: a NAT-ed Android emulator saw zero
    // peers while the host CLI saw it advertising).
    const target = addr ?? (await this.devices()).find((d) => d.deviceId === deviceId)?.addr;
    if (!target) throw new Error(`unknown device ${deviceId}`);
    if (mode === 'code') {
      // The secret is the six digit code here, not the QR bundle CBOR.
      if (!secret) throw new Error('code pairing needs the six digit code');
      const { sas } = JSON.parse(await this.native.pairWithCode(target, secret));
      return { sas };
    }
    if (!secret) throw new Error('qr pairing needs the bundle hex');
    const { sas } = JSON.parse(await this.native.pairWith(target, hexToBytes(secret)));
    return { sas };
  }

  readonly codePairingSupported = true;

  armCodePairing(): Promise<string> {
    return this.native.armCodePairing();
  }

  async cancelCodePairing(): Promise<void> {
    await this.native.cancelCodePairing();
  }

  async codePairingStatus(): Promise<CodePairingStatus> {
    // The FFI speaks snake_case; the UI reads camelCase.
    const raw = JSON.parse(await this.native.codePairingStatus()) as {
      state: CodePairingStatus['state'];
      remaining_ms: number;
      tries_left: number;
    };
    return { state: raw.state, remainingMs: raw.remaining_ms, triesLeft: raw.tries_left };
  }

  // C2: the HOST half. The host scanned the joiner's bundle, so it already
  // holds the exact bytes `pair` passes the other way; hand them to the native
  // arm and the engine's pending slot is set for the inbound connection. No
  // reply, no id -- arming is a local state change, and the result of the
  // pairing arrives as the `pairing.sas` / `pairing.done` events.
  async offerPairing(bundleCborHex: string): Promise<void> {
    await this.native.offerPairing(hexToBytes(bundleCborHex));
  }

  // Spec 3.3 Mode A. No bundle crosses: the host has none, and the engine
  // learns the peer's identity in-band. See the trust-surface note on
  // DaakEngine.armHostPairing.
  async armHostPairing(): Promise<void> {
    await this.native.armHostPairing();
  }

  async send(req: SendRequest): Promise<{ transferId: string; queued: boolean }> {
    const hasText = typeof req.text === 'string' && req.text.length > 0;
    const hasFiles = (req.files?.length ?? 0) > 0;
    if (hasText && hasFiles) throw new Error('send takes text or files, not both');
    if (!hasText && !hasFiles) throw new Error('refusing an empty send');
    // Both native sends go through the outbox (R7), so the id comes back
    // immediately whether or not the peer is online. `queued: true` is the
    // HONEST reading: it means the share is durably queued, not delivered. The
    // outbox returns a row id, not a delivery state, and spec 6.2's
    // SendRequest -> {transferId, queued} has no third field to widen into.
    // Delivery is a separate signal: transfers.state plus transfer.done /
    // transfer.failed events.
    if (hasText) {
      return { transferId: await this.native.sendText(req.peerDeviceId, req.text as string), queued: true };
    }
    return { transferId: await this.native.sendFiles(req.peerDeviceId, req.files ?? []), queued: true };
  }

  async cancel(transferId: string): Promise<void> {
    await this.native.cancel(transferId);
  }

  async revokePairing(deviceId: string): Promise<void> {
    await this.native.revokePairing(deviceId);
  }

  async confirmPairing(deviceId: string): Promise<void> {
    await this.native.confirmPairing(deviceId);
  }

  async backgroundWake(): Promise<void> {
    await this.native.backgroundWake();
  }

  async replaceInboxPaths(payloadId: string, paths: string[]): Promise<void> {
    await this.native.replaceInboxPaths(payloadId, paths);
  }

  async retry(transferId: string): Promise<void> {
    await this.native.retry(transferId);
  }

  async retryItem(transferId: string, itemIndex: number): Promise<void> {
    await this.native.retryItem(transferId, itemIndex);
  }

  async quarantineReport(transferId: string, itemIndex: number): Promise<QuarantineReport> {
    const parsed: unknown = JSON.parse(await this.native.quarantineReport(transferId, itemIndex));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('quarantineReport did not return an object');
    }
    return parsed as QuarantineReport;
  }

  async deleteQuarantined(transferId: string, itemIndex: number): Promise<void> {
    await this.native.deleteQuarantined(transferId, itemIndex);
  }

  async listQuarantineReports(): Promise<QuarantineReport[]> {
    const parsed: unknown = JSON.parse(await this.native.listQuarantineReports());
    if (!Array.isArray(parsed)) throw new Error('listQuarantineReports did not return an array');
    return parsed as QuarantineReport[];
  }

  // The UDL has no map type, so the filter crosses as JSON. "{}" means
  // "no filter", which is exactly what an absent filter means on the engine.
  async listTransfers(filter?: TransferFilter): Promise<TransferSummary[]> {
    const parsed: unknown = JSON.parse(await this.native.listTransfers(JSON.stringify(filter ?? {})));
    if (!Array.isArray(parsed)) throw new Error('listTransfers did not return an array');
    return parsed as TransferSummary[];
  }

  async listInbox(): Promise<InboxEntry[]> {
    const parsed: unknown = JSON.parse(await this.native.listInbox());
    if (!Array.isArray(parsed)) throw new Error('listInbox did not return an array');
    return parsed as InboxEntry[];
  }
  async listThread(peerDeviceId: string, opts?: { limit?: number; before?: string }): Promise<ThreadPage> {
    const threadLimit = (opts && opts.limit !== undefined) ? opts.limit : 50;
    const threadBefore = (opts && opts.before !== undefined) ? opts.before : '';
    const parsed: unknown = JSON.parse(await this.native.listThread(peerDeviceId, threadLimit, threadBefore));
    const pg = parsed as Partial<ThreadPage> | null;
    if (typeof pg !== 'object' || pg === null || !Array.isArray(pg.items)) {
      throw new Error('listThread did not return a page');
    }
    return pg as ThreadPage;
  }
  async getItemText(transferId: string, itemIndex: number): Promise<string> {
    // The native module returns the text itself, not JSON.
    return this.native.getItemText(transferId, itemIndex);
  }

  async selfProfile(): Promise<SelfProfile> {
    const parsed: unknown = JSON.parse(await this.native.selfProfile());
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('selfProfile did not return an object');
    }
    const { name, baseName, deviceId } = parsed as {
      name?: unknown;
      baseName?: unknown;
      deviceId?: unknown;
    };
    // Validated, not cast: Settings PREFILLS this box from this, and an empty
    // name would silently wipe what the user had already typed.
    //
    // baseName is validated for the same reason and with the same rule: the box
    // shows the BASE name (the prefix on `name` is a LAN artifact), so a bridge
    // that dropped the field would leave the box blank rather than fail loudly.
    if (typeof name !== 'string' || typeof baseName !== 'string' || typeof deviceId !== 'string') {
      throw new Error('selfProfile returned no name/baseName/deviceId');
    }
    return { name, baseName, deviceId };
  }

  async setDisplayName(name: string): Promise<void> {
    await this.native.setDisplayName(name);
  }

  async setPresence(state: 'online' | 'away'): Promise<void> {
    await this.native.setPresence(state);
  }

  on(cb: (e: DaakEvent) => void): () => void {
    return this.subscribe((raw) => {
      const s = typeof raw === 'string' ? raw : raw?.event;
      if (typeof s !== 'string') return;
      let e: DaakEvent | undefined;
      try {
        const parsed = JSON.parse(s) as DaakEvent;
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
