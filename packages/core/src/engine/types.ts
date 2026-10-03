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
  /**
   * `null` when the stored value would not parse. `[]` is a real answer
   * ("this payload saved no files"), so a corrupt row must stay
   * distinguishable from it -- both engines (daakd and daak-ffi) return null
   * for an unparseable saved_paths blob.
   */
  savedPaths: string[] | null;
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
  | { type: 'inbox.received'; payload: InboxEntry }
  /**
   * A peer on this LAN speaks a protocol version this build refuses, so the
   * engine dropped it from the device list (core's discovery task calls
   * ensure_compatible and skips). It is reported rather than only logged so
   * the UI can say WHY a paired-looking device is not in the list.
   *
   * BOTH numbers are real and BOTH are needed: peerVersion is what the device
   * advertised in its mDNS TXT record, ourVersion is this build's manifest
   * version. One number cannot distinguish "they need updating" from "we are
   * the old one", and those need different advice.
   *
   * NOT defaulting a version is a property of each BRIDGE, not of this union.
   * The FFI bridge cannot invent one: ffi_event_json reads the two u16s straight
   * off the engine event. The daemon bridge COULD: toDaakEvent's num() was
   * Number(v ?? 0), so a MISSING or non-numeric version became 0 until it was
   * changed to drop such an event instead. Both bridges now refuse to hand the
   * UI a version they did not read; neither substitutes a number for it.
   */
  | {
      type: 'peer.incompatible';
      peerDeviceId: string;
      peerName: string;
      peerVersion: number;
      ourVersion: number;
    };

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

/** This device's own advertised name and id. The READ half of setDisplayName. */
export interface SelfProfile {
  /** The RESOLVED name, with any LAN-collision suffix -- what peers see. */
  name: string;
  deviceId: string;
}

export interface DaakEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
  devices(): Promise<DeviceInfo[]>;
  pair(deviceId: string, mode: 'qr' | 'code', secret?: string): Promise<{ sas: string }>;
  /**
   * HOST half of QR pairing: arm the engine to accept the peer whose bundle
   * CBOR hex is given, before that peer dials in. Without it the host's own QR
   * is decorative -- the inbound connection is refused as unpaired and the
   * host's `pairing.sas` never fires.
   *
   * Mobile-only: it is a method on the in-process FFI engine, and there is
   * deliberately no `IpcRequest` for it (see DaemonClientEngine).
   */
  offerPairing(bundleCborHex: string): Promise<void>;
  /**
   * HOST half of QR pairing, spec 3.3 Mode A: arm the accept slot for the first
   * inbound pairing, naming no peer.
   *
   * This is the arm a real user reaches. The QR flow is asymmetric -- only the
   * JOINER scans, so only the joiner ever holds the host's bundle, and the
   * sanctioned flow never gives the host the joiner's. `offerPairing` above
   * needs a bundle and is therefore the re-arm path for a caller that has one.
   *
   * TRUST SURFACE: the host has no pre-known peer, so it cannot pre-empt an
   * identity substitution the way `offerPairing` does. The engine still
   * verifies the in-band identity (device-id agreement plus the static-key
   * binding), authenticates it in the Noise XX handshake, confirms the session
   * per spec 3.5, and derives the SAS from a hash bound to both static keys.
   * What the user gains is comparing the two SAS values; that comparison is now
   * the only thing binding the peer's self-declared identity to a human.
   *
   * One-shot: the accept slot is consumed by the connection it accepts.
   * Mobile-only: it arms in-process engine state, and there is deliberately
   * no `IpcRequest` for it (see DaemonClientEngine).
   */
  armHostPairing(): Promise<void>;
  send(req: SendRequest): Promise<{ transferId: string; queued: boolean }>;
  cancel(transferId: string): Promise<void>;
  retry(transferId: string): Promise<void>;
  listTransfers(filter?: TransferFilter): Promise<TransferSummary[]>;
  listInbox(): Promise<InboxEntry[]>;
  selfProfile(): Promise<SelfProfile>;
  setDisplayName(name: string): Promise<void>;
  setPresence(state: 'online' | 'away'): Promise<void>;
  on(cb: (event: DaakEvent) => void): () => void;
}
