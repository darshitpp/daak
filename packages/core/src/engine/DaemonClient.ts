import type { DaakEngine, DaakEvent, DeviceInfo, InboxEntry, ItemState, SendRequest } from './types';
import { IpcTransport, type IpcEvent } from '../ipc/transport';

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

  constructor(private tx: IpcTransport) {
    tx.onEvent = (ev: IpcEvent) => this.dispatch(ev);
  }

  static async connect(sockPath: string): Promise<DaemonClientEngine> {
    return new DaemonClientEngine(await IpcTransport.connect(sockPath));
  }

  // The daemon is already running, so start() only subscribes to the event
  // stream. IpcRequest::Start (data_dir, display_name, listen_port) exists but
  // daakd answers it "unimplemented" until Task 9 wires the engine, so
  // sending it would make every desktop client fail to come up. Task 9
  // restores it once the daemon owns an engine.
  async start(): Promise<void> {
    await this.tx.request({ Request: 'Subscribe' });
  }

  // Shutdown: the daemon closes the connection and sends no response, so this
  // must not wait for one.
  async stop(): Promise<void> {
    this.tx.send({ Request: 'Shutdown' });
  }

  async devices(): Promise<DeviceInfo[]> {
    // Json{value} carries a JSON STRING; the daemon does not parse it.
    return parseArray<DeviceInfo>(await this.json('Devices'), 'devices');
  }

  async pair(deviceId: string, _mode: 'qr' | 'code', _secret?: string): Promise<{ sas: string }> {
    // Pair is not on the daemon's dispatch table until Task 9, and the FFI
    // surface has no manual-code method at all (InProcess throws for it), so
    // both modes fail here rather than sending a request that cannot work.
    throw new Error(`pairing (${deviceId}) is not wired through daakd yet; see Task 9`);
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

  async listTransfers(): Promise<unknown[]> {
    return parseArray<unknown>(await this.json('ListTransfers'), 'listTransfers');
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
    if (r && typeof r === 'object' && 'Json' in r) return r.Json.value;
    if (r && typeof r === 'object' && 'Port' in r) return String(r.Port.port);
    return 'null';
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
    case 'TransferProgress':
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
      // pairing.done has no IpcEvent variant at all, and an unknown variant is
      // dropped rather than handed to the UI as a malformed event (R20).
      return undefined;
  }
}
