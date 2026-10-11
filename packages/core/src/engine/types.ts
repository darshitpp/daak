export interface DeviceInfo {
  deviceId: string;
  name: string;
  addr: string;
  /** Present for peers discovered via mDNS; derived from presence when known. */
  online?: boolean;
  /**
   * R42g: a live pairing exists with this device. Discovery and trust are
   * different facts -- an mDNS announce lists a peer the engine will refuse to
   * send to. The UI offers Send when this is true and Pair when it is not.
   */
  paired?: boolean;
  /**
   * Set by the engine for a PAIRED peer only: online, away (the peer says
   * so in its sealed beacon), or offline. An unpaired device has no
   * presence. Online is true for online and away.
   */
  presence?: 'online' | 'away' | 'offline';
}

export type ItemState = 'pending' | 'receiving' | 'verifying' | 'done' | 'failed' | 'quarantined';

/**
 * One held-back (quarantined) item, as the "Held back" screen shows it.
 *
 * Every field is either measured or recorded, never defaulted. `expected` is
 * the fingerprint the SENDER attested in the manifest; `actual` was computed
 * from the bytes on this disk. They are returned as a PAIR and never as a
 * verdict, because comparing them is the security decision and it belongs to
 * the person reading the screen.
 *
 * The `| null` fields are null when this device never recorded them -- an
 * unpaired sender has no stored name, and a name is never invented from an id
 * prefix on a screen whose whole job is honesty about what is not verified.
 * `senderDeviceId` exists for exactly that case: it is a REAL identifier, so
 * "Device aabbccdd" is a fact and a made-up handle is not.
 */
export interface QuarantineReport {
  transferId: string;
  itemIndex: number;
  name: string | null;
  /** Bytes, from the item row. Null when the sender attached no size. */
  size: number | null;
  /** The peer's PAIRED label. Null when none was ever recorded. */
  senderName: string | null;
  /** The peer's device id, from the transfer row. Null only with no row. */
  senderDeviceId: string | null;
  /** Unix seconds, from the transfer row. Null when there is no row to read. */
  receivedAt: number | null;
  /** 64 hex chars: what the sender said the file should hash to. */
  expected: string;
  /** 64 hex chars: what the bytes on this disk actually hash to. */
  actual: string;
  /** Where the held bytes are. Derived from the receive root, not read back from a stored path. */
  heldPath: string;
}

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
  | { type: 'device.presence'; deviceId: string; presence: 'online' | 'away' }
  | { type: 'pairing.sas'; peerDeviceId: string; sas: string }
  | { type: 'pairing.done'; deviceId: string }
  | { type: 'pairing.revoked'; deviceId: string }
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
   * the old one", and those need different advice. Neither is ever defaulted.
   */
  | {
      type: 'peer.incompatible';
      peerDeviceId: string;
      peerName: string;
      peerVersion: number;
      ourVersion: number;
    }
  /** The unsent outbox count for a peer, so the UI can show "N queued". */
  | { type: 'outbox.queued'; deviceId: string; queued: number };

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

export interface ThreadItem {
  transferId: string;
  itemIndex: number;
  direction: 'in' | 'out';
  type: 'text' | 'file';
  name: string | null;
  size: number | null;
  text: string | null;
  state: ItemState;
  destPath: string | null;
  at: number;
  transferState: string;
  error: string | null;
  /** The item list of this transfer was cut to fit the page budget. */
  truncated?: boolean;
  /** The text of this item was cut to fit the page budget. */
  textTruncated?: boolean;
}

export interface ThreadPage {
  items: ThreadItem[];
  olderCursor: string | null;
}

/** This device's own advertised name and id. The READ half of setDisplayName. */
export interface SelfProfile {
  /** The RESOLVED name, with any LAN-collision suffix -- what peers see. */
  name: string;
  /**
   * The name the user last typed, BEFORE LAN collision resolution. This is
   * what the settings file holds and what a rename box must show. A collision
   * prefixes `name` with "<Adjective> <Animal> · ", which is a LAN artifact a
   * user never typed -- so the box reads THIS field and not `name`.
   */
  baseName: string;
  deviceId: string;
}

export interface DaakEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
  devices(): Promise<DeviceInfo[]>;
  /**
   * Unpair a peer from THIS device. Local trust, so either side may revoke
   * without the other's agreement. The peer returns to the unpaired state, so
   * the UI stops offering Send and offers Pair again.
   */
  revokePairing(deviceId: string): Promise<void>;
  /**
   * The user compared the SAS and it matched. A new pairing is pending until
   * this call, and a pending pairing grants nothing. Rejecting a pairing is
   * `revokePairing`. Resolves without effect when the engine does not gate
   * pairings (the daemon confirms its own).
   */
  confirmPairing(deviceId: string): Promise<void>;
  /**
   * A platform wake, such as a background refresh, tells the engine to drain
   * the outbox now instead of waiting for the next poll tick. The Rust side is
   * a stub until Task 4, so the call resolves and does nothing today.
   */
  backgroundWake(): Promise<void>;
  /**
   * R42p: record where the platform MOVED a received payload's files.
   *
   * The move happens outside the engine, because an Android SAF tree has no
   * path the engine can write to. `savedPaths` is what the Inbox opens, so
   * without this the row names a file that is no longer there.
   */
  replaceInboxPaths(payloadId: string, paths: string[]): Promise<void>;
  /**
   * `addr` is an OPTIONAL `host:port` for the peer. Given one, it is dialed
   * directly; omitted, the address is resolved from discovery as before.
   *
   * A pairing link can name the host's address, and mDNS does not cross every
   * network Daak runs on -- a NAT'd emulator or a switched AP can leave the
   * joiner with no announce to resolve. The address is link metadata; the
   * `PairingBundle` CBOR is unchanged, so this is not a wire change.
   */
  pair(deviceId: string, mode: 'qr' | 'code', secret?: string, addr?: string): Promise<{ sas: string }>;
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
  /**
   * Re-arm ONE item of a transfer, rather than the whole transfer.
   *
   * PARKED, and deliberately not on any user-facing surface. It moves the
   * item's row to 'pending' and pokes the outbox worker, and NOTHING consumes
   * that: `due_outbox` returns OUTBOUND rows only, so a transfer that ARRIVED
   * at this device has no row to drain, and the wire protocol has no
   * receiver-initiated re-fetch message. So today the item goes to 'pending'
   * and waits for a fetch loop that does not exist.
   *
   * It is kept because the state transition is real and pinned, and it is kept
   * off the screens because a button labelled "Ask the sender again" wired to
   * this would move a held-back file into a state that reads as "being
   * fetched" while nothing fetches it. `quarantineReport` is what a user is
   * shown instead. When the re-fetch wire message lands, this becomes the
   * caller of it.
   *
   * Rejects when the transfer or the item does not exist, rather than
   * resolving and silently doing nothing.
   */
  retryItem(transferId: string, itemIndex: number): Promise<void>;
  /**
   * Read one held-back item back: what was recorded about it, and BOTH
   * fingerprints -- the one the sender attested and the one these bytes
   * actually produce.
   *
   * A READ. It changes no state, so opening the screen is free and cannot
   * change what is being held. There is deliberately no "recovered" answer and
   * no "ask the sender again" here: the held bytes are the exact bytes that
   * just failed this comparison, so re-reading them can only reproduce the
   * same mismatch, and Daak's wire protocol is push-only -- a receiver has no
   * message it can send a sender to request a file it already delivered.
   *
   * Rejects when the transfer or the item does not exist, rather than
   * resolving and showing an empty screen.
   */
  quarantineReport(transferId: string, itemIndex: number): Promise<QuarantineReport>;
  /**
   * Discard a held-back item: removes the held file and its row, so a transfer
   * whose last outstanding item the user gave up on stops reading as though
   * something were still waiting.
   *
   * Refuses any item that is not `quarantined`. A delivered file lives at the
   * receiver's real destination, so deleting it through this path would have
   * to guess which file the name refers to.
   */
  deleteQuarantined(transferId: string, itemIndex: number): Promise<void>;
  /**
   * Every item this device is currently holding back, newest arrival first.
   *
   * The DISCOVERY half of `quarantineReport`, and the reason that method is
   * usable at all: a screen cannot ask for a (transferId, itemIndex) pair the
   * user has never seen, and the only way to find one by guessing is to hash
   * every item of every transfer until something stops erroring.
   */
  listQuarantineReports(): Promise<QuarantineReport[]>;
  listTransfers(filter?: TransferFilter): Promise<TransferSummary[]>;
  listInbox(): Promise<InboxEntry[]>;
  /**
   * One page of the thread of a peer: sent and received items together,
   * oldest first within the page. Limit defaults to 50 and the engine clamps
   * it to 200. Before is the olderCursor of the previous page. A cursor that
   * does not parse rejects.
   */
  listThread(peerDeviceId: string, opts?: { limit?: number; before?: string }): Promise<ThreadPage>;
  /**
   * The whole text of one text item. A thread page cuts a long text to fit
   * its budget (`textTruncated`), so a copy of the page text can lose data.
   * Rejects for an id that does not parse, a transfer or item that does not
   * exist, an item that is not a text, and a text longer than 3 MiB.
   */
  getItemText(transferId: string, itemIndex: number): Promise<string>;
  selfProfile(): Promise<SelfProfile>;
  setDisplayName(name: string): Promise<void>;
  setPresence(state: 'online' | 'away'): Promise<void>;
  on(cb: (event: DaakEvent) => void): () => void;
}
