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

export interface DaakEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
  devices(): Promise<DeviceInfo[]>;
  pair(deviceId: string, mode: 'qr' | 'code', secret?: string): Promise<{ sas: string }>;
  send(req: SendRequest): Promise<{ transferId: string; queued: boolean }>;
  cancel(transferId: string): Promise<void>;
  retry(transferId: string): Promise<void>;
  listTransfers(): Promise<unknown[]>;
  listInbox(): Promise<InboxEntry[]>;
  setDisplayName(name: string): Promise<void>;
  setPresence(state: 'online' | 'away'): Promise<void>;
  on(cb: (event: DaakEvent) => void): () => void;
}
