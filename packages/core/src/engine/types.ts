export interface DeviceInfo {
  deviceId: string;
  name: string;
  addr: string;
  /** Present for peers discovered via mDNS; derived from presence when known. */
  online?: boolean;
}

export type ItemState = 'pending' | 'receiving' | 'verifying' | 'done' | 'failed' | 'quarantined';

export interface InboxEntry {
  payloadId: string;
  transferId: string;
  peerDeviceId: string;
  kind: 'text' | 'media' | 'batch';
  itemCount: number;
  summary: string;
  receivedAt: number;
  savedPaths: string[];
}

export type DaakEvent =
  | { type: 'device.discovered'; device: DeviceInfo }
  | { type: 'device.state'; deviceId: string; state: 'online' | 'offline' }
  | { type: 'pairing.sas'; peerDeviceId: string; sas: string }
  | { type: 'pairing.done'; deviceId: string }
  | { type: 'transfer.progress'; transferId: string; bytesDone: number; bytesTotal: number }
  | { type: 'transfer.item'; transferId: string; itemIndex: number; state: ItemState; destPath?: string }
  | { type: 'transfer.done'; transferId: string }
  | { type: 'transfer.failed'; transferId: string; error: string }
  | { type: 'inbox.received'; payload: InboxEntry };

export interface SendRequest {
  peerDeviceId: string;
  text?: string;
  files?: string[];
}

export interface TransferSummary {
  transferId: string;
  peerDeviceId: string;
  direction: 'in' | 'out';
  kind: 'text' | 'media' | 'batch';
  /** spec 4.2's transfers.state vocabulary, NOT transfer_items.state. */
  state: string;
  bytesDone: number;
  bytesTotal: number;
  itemCount: number;
  updatedAt: number;
}

export interface TransferFilter {
  state?: string;
  /** 32 hex chars (16 bytes), the same shape every id in this API is. */
  peerDeviceId?: string;
}

export interface DaakEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
  devices(): Promise<DeviceInfo[]>;
  pair(deviceId: string, mode: 'qr' | 'code', secret?: string): Promise<{ sas: string }>;
  send(req: SendRequest): Promise<{ transferId: string; queued: boolean }>;
  cancel(transferId: string): Promise<void>;
  retry(transferId: string): Promise<void>;
  listTransfers(filter?: TransferFilter): Promise<TransferSummary[]>;
  listInbox(): Promise<InboxEntry[]>;
  setDisplayName(name: string): Promise<void>;
  setPresence(state: 'online' | 'away'): Promise<void>;
  on(cb: (event: DaakEvent) => void): () => void;
}
