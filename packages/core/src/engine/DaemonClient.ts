import type {
  DaakEngine,
  DaakEvent,
  DeviceInfo,
  InboxEntry,
  ItemState,
  SendRequest,
  TransferFilter,
  TransferSummary,
} from './types';
import { homedir } from 'node:os';
import {
  IpcTransport,
  IpcUpdateRequiredError,
  type IpcEvent,
} from '../ipc/transport';

// Re-exported so the UI can catch a version mismatch without knowing which
// transport produced it: `catch (e) { if (e instanceof IpcUpdateRequiredError)
// showUpdatePrompt() }`.
export { IpcUpdateRequiredError, IpcVersionError } from '../ipc/transport';

// The DaakEngine over the daakd IPC socket. Every method maps onto one
// IpcRequest variant; there is no lowercase `kind` envelope, the plan's sketch
// was wrong about that.
//
// ponytail: this class does NOT reconnect. A dropped daemon rejects the
// in-flight request and every later one; supervising daakd (launchd / systemd
// / the Win32 service) and re-subscribing belongs to the app shell in Phase
// 7/8, where the restart policy and a UI reconnection state belong. Doing it
// here would need retry backoff, a subscription replay and a send queue, none
// of which anything can exercise until the app exists.
export class DaemonClientEngine implements DaakEngine {
  private handlers = new Set<(e: DaakEvent) => void>();
  /** The args Start was sent with, so a second start() is a no-op rather than
   * a conflicting Start the daemon would refuse. */
  private startedWith?: { data_dir: string; display_name: string; listen_port: number };

  constructor(private tx: IpcTransport) {
    tx.onEvent = (ev: IpcEvent) => this.dispatch(ev);
  }

  static async connect(sockPath: string): Promise<DaemonClientEngine> {
    return new DaemonClientEngine(await IpcTransport.connect(sockPath));
  }

  // Start creates the daemon's engine, so it MUST be sent before anything else
  // and before Subscribe: without a Subscribe the event stream is never fanned
  // out to this connection. Sent first because every other request answers
  // Error{"engine not started"} until it lands.
  async start(): Promise<void> {
    if (!this.startedWith) {
      const args = {
        // snake_case, NOT camelCase: cbor-x writes JS property names verbatim
        // and IpcRequest has no rename_all, so these keys ARE the wire format.
        // camelCase here fails to deserialise and every later request then
        // answers "engine not started". Pinned by
        // crates/daak-ipc/tests/schema.rs::a_camel_case_start_does_not_decode.
        data_dir: defaultDataDir(),
        display_name: 'daak',
        // 0: the daemon picks a free port and answers IpcResponse::Port.
        // A fixed port would make two daemons on one machine collide.
        listen_port: 0,
      };
      // Assign only AFTER the await: a failed Start left the flag set, so
      // every later start() skipped Start and the client was stuck on
      // "engine not started" forever.
      await this.tx.request({ Request: { Start: args } });
      this.startedWith = args;
    }
    await this.tx.request({ Request: 'Subscribe' });
  }

  // Shutdown: the daemon closes the connection and sends no response, so this
  // must not wait for one.
  async stop(): Promise<void> {
    this.tx.send({ Request: 'Shutdown' });
    // Shutdown TAKES the engine out of the daemon's slot (B4), so a start()
    // after a stop() must really send Start again -- otherwise the client
    // skips it and every request answers "engine not started". This class
    // still does NOT reconnect: a fresh DaemonClientEngine is the only way
    // back onto a closed socket.
    this.startedWith = undefined;
  }

  async devices(): Promise<DeviceInfo[]> {
    // Json{value} carries a JSON STRING; the daemon does not parse it.
    return parseArray<DeviceInfo>(await this.json('Devices'), 'devices');
  }

  async pair(deviceId: string, mode: 'qr' | 'code', secret?: string): Promise<{ sas: string }> {
    // IpcRequest::Pair carries an addr plus a CBOR bstr, and there is no
    // manual-code request on the wire (the FFI has no such method either, and
    // InProcess throws for it), so code mode is refused rather than sent.
    if (mode === 'code') throw new Error('manual-code pairing is not on the FFI surface yet');
    if (!secret) throw new Error('qr pairing needs the bundle hex');
    // The request takes an ip:port, not a device id (R13), so resolve it from
    // the daemon's device list. `secret` is the bundle CBOR as hex.
    const device = (await this.devices()).find((d) => d.deviceId === deviceId);
    if (!device) throw new Error(`unknown device ${deviceId}`);
    const r = JSON.parse(
      await this.json({
        Pair: {
          addr: device.addr,
          // A Node Buffer, NOT number[]: cbor-x encodes a number[] as a CBOR
          // ARRAY and daak-ipc deserialises bundle_cbor as a bstr (R27).
          bundle_cbor: Buffer.from(secret, 'hex'),
        },
      }),
    ) as { sas?: string };
    if (typeof r.sas !== 'string') throw new Error('daakd pair returned no sas');
    return { sas: r.sas };
  }

  // C2: the host arm is IN-PROCESS ONLY and that is deliberate, not a gap I
  // papered over. Adding it to the daemon would mean a new IpcRequest variant,
  // which the C2 brief forbids (a new method on the FFI interface is not a new
  // request, and a new request is what owes an IPC_MINOR bump). Until the
  // desktop ships that request, a desktop UI calling this must fail loudly -- a
  // silent no-op would leave the host showing a QR that accepts nothing, which
  // is the bug C2 is about.
  async offerPairing(_bundleCborHex: string): Promise<void> {
    throw new Error('host QR arming is mobile-only: no IpcRequest offers a pairing');
  }

  // Same ruling as offerPairing above, and for the same reason: the arm is
  // in-process engine state. There is no IpcRequest that arms a pairing, the
  // C2 brief forbids adding one, and adding one is exactly what would owe an
  // IPC_MINOR bump. Loud, not silent -- a desktop host that no-oped here would
  // show a QR that accepts nothing.
  async armHostPairing(): Promise<void> {
    throw new Error('host QR arming is mobile-only: no IpcRequest arms a pairing');
  }

  async send(req: SendRequest): Promise<{ transferId: string; queued: boolean }> {
    const hasText = typeof req.text === 'string' && req.text.length > 0;
    const hasFiles = (req.files?.length ?? 0) > 0;
    if (hasText && hasFiles) throw new Error('send takes text or files, not both');
    if (!hasText && !hasFiles) throw new Error('refusing an empty send');
    const r = JSON.parse(
      await this.json({ Send: { peer_device_id: req.peerDeviceId, text: req.text ?? null, files: req.files ?? [] } }),
    ) as { transferId?: string; queued?: boolean };
    if (typeof r.transferId !== 'string') throw new Error('daakd send returned no transferId');
    return { transferId: r.transferId, queued: Boolean(r.queued) };
  }

  async cancel(transferId: string): Promise<void> {
    await this.tx.request({ Request: { Cancel: { transfer_id: transferId } } });
  }

  async retry(transferId: string): Promise<void> {
    await this.tx.request({ Request: { Retry: { transfer_id: transferId } } });
  }

  async listTransfers(filter?: TransferFilter): Promise<TransferSummary[]> {
    // The filter is a map, not a bare string: the request variant is
    // ListTransfers { filter: Option<TransferFilter> } and an absent filter
    // lists EVERYTHING, which is a different query from any filter.
    // B1: build the wire object EXPLICITLY. cbor-x writes property names
    // verbatim and IpcRequest/TransferFilter have no rename_all, so passing
    // the TS filter through sent `peerDeviceId`, which serde dropped -- the
    // peer filter became None and the query returned the WHOLE table.
    // TransferFilter is deny_unknown_fields, so a casing typo is now a decode
    // error rather than a silently wider query. undefined keys are omitted so
    // an absent filter field keeps meaning "no narrowing".
    const wire = filter
      ? {
          ...(filter.state !== undefined ? { state: filter.state } : {}),
          ...(filter.peerDeviceId !== undefined
            ? { peer_device_id: filter.peerDeviceId }
            : {}),
        }
      : null;
    return parseArray<TransferSummary>(
      await this.json({ ListTransfers: { filter: wire } }),
      'listTransfers',
    );
  }

  async listInbox(): Promise<InboxEntry[]> {
    return parseArray<InboxEntry>(await this.json('ListInbox'), 'listInbox');
  }

  async setDisplayName(name: string): Promise<void> {
    await this.tx.request({ Request: { SetDisplayName: { name } } });
  }

  async setPresence(state: 'online' | 'away'): Promise<void> {
    await this.tx.request({ Request: { SetPresence: { state } } });
  }

  on(cb: (e: DaakEvent) => void): () => void {
    this.handlers.add(cb);
    return () => { this.handlers.delete(cb); };
  }

  private async json(req: unknown): Promise<string> {
    const r = await this.tx.request({ Request: req });
    // A version mismatch is not a malformed reply, so it must NOT fall into
    // the "expected a Json response" error below: the caller needs the name
    // and the min_major to show an update prompt.
    if (typeof r === 'object' && r !== null && 'UpdateRequired' in r) {
      throw new IpcUpdateRequiredError(r.UpdateRequired.min_major);
    }
    if (typeof r === 'object' && r !== null && 'Json' in r) return r.Json.value;
    // No Port branch on purpose: nothing asks for one today, and a default of
    // 'null' here turned a malformed reply into a null-deref or a silent null
    // value instead of a named protocol error.
    throw new Error(`expected a Json response, got ${JSON.stringify(r)}`);
  }

  private dispatch(ev: Record<string, Record<string, unknown>>): void {
    const [name, data] = Object.entries(ev)[0] ?? [];
    if (!name || !data) return;
    const e = toDaakEvent(name, data);
    if (!e) return;
    for (const h of this.handlers) h(e);
  }
}

function parseArray<T>(json: string, what: string): T[] {
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) throw new Error(what + ' did not return an array');
  return parsed as T[];
}

// Where the daemon keeps its state. Per-platform app-data directories, NOT
// /tmp: the SQLite database and the identity keys must outlive a reboot and
// must not be readable by another user.
// ponytail: hard-coded, because the OS-native data dir is a platform-
// packaging question (launchd/systemd/Win32 service install, Phase 8). Until
// then this is the conventional location and it is per-user, not shared.
function defaultDataDir(): string {
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return `${home}/Library/Application Support/dev.darshit.daak`;
    case 'win32':
      return `${process.env.LOCALAPPDATA ?? `${home}/AppData/Local`}/Daak/DaakDaemon`;
    default:
      return `${process.env.XDG_DATA_HOME ?? `${home}/.local/share`}/daak`;
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));
const num = (v: unknown): number => Number(v ?? 0);

// IpcEvent -> DaakEvent. The wire is snake_case, the union is camelCase.
export function toDaakEvent(name: string, d: Record<string, unknown>): DaakEvent | undefined {
  switch (name) {
    case 'DeviceFound':
      return { type: 'device.discovered', device: { deviceId: str(d.device_id), name: str(d.name), addr: str(d.addr) } };
    case 'DeviceState':
      return { type: 'device.state', deviceId: str(d.device_id), state: d.online ? 'online' : 'offline' };
    case 'PairingSas':
      return { type: 'pairing.sas', peerDeviceId: str(d.peer_device_id), sas: str(d.sas) };
    // C2: IpcEvent::PairingDone exists on the wire (proto/ipc.cddl
    // pairing-done-event, daemon-side to_ipc_event arm). Same field name and
    // same hex id as the FFI arm, so both bridges hand the UI one shape.
    case 'PairingDone':
      return { type: 'pairing.done', deviceId: str(d.device_id) };
    case 'TransferProgress':
      // ponytail: u64 -> number is lossy above 2^53, which the 4 MiB frame cap
      // and a 1 MiB chunk size make unreachable. Use bigint if that changes.
      return { type: 'transfer.progress', transferId: str(d.transfer_id), bytesDone: num(d.bytes_done), bytesTotal: num(d.bytes_total) };
    case 'TransferItem':
      return {
        type: 'transfer.item',
        transferId: str(d.transfer_id),
        itemIndex: num(d.item_index),
        state: str(d.state) as ItemState,
        destPath: str(d.dest_path),
      };
    case 'TransferDone':
      return { type: 'transfer.done', transferId: str(d.transfer_id) };
    case 'TransferFailed':
      return { type: 'transfer.failed', transferId: str(d.transfer_id), error: str(d.error) };
    case 'InboxReceived':
      // payload_json is a raw JSON STRING on the wire but DaakEvent types the
      // payload as an InboxEntry, so the client parses it.
      try {
        return { type: 'inbox.received', payload: JSON.parse(str(d.payload_json)) as InboxEntry };
      } catch {
        return undefined;
      }
    default:
      // An unknown variant is dropped rather than handed to the UI as a
      // malformed event (R20).
      return undefined;
  }
}
