// The DAAK IPC wire format as daak-ipc actually implements it -- NOT the plan's
// lowercase `kind` sketch, which does not exist on the wire:
//
//   frame = 'DAAK' || u32 BE length || CBOR({ v: version, msg: IpcMessage })
//
// "v" is the IPC schema version, a uint whose HIGH byte is the major and low
// byte the minor (daak_ipc::IPC_MAJOR / IPC_MINOR). 1.0 is 0x0100 = 256, which
// CBOR writes as the three bytes 19 01 00 because it does not fit the
// one-byte small-int form. A different MAJOR is refused; a different MINOR is
// accepted (additive fields live there), and unknown keys in the frame are
// IGNORED, so a 1.9 peer still talks to a 1.0 daemon.
//
// IpcMessage is serde EXTERNALLY TAGGED, so each frame is a one-key map:
//   IpcRequest::Subscribe       -> {"Request": "Subscribe"}  (unit variant)
//   IpcRequest::Devices         -> {"Request": "Devices"}    (unit variant)
//   IpcRequest::Start{..}       -> {"Request": {"Start": {..}}}
//   IpcResponse::Ok             -> {"Response": "Ok"}   (unit -> bare string)
//   IpcResponse::Error{message} -> {"Response": {"Error": {"message": ".."}}}
//   IpcResponse::Json{value}    -> {"Response": {"Json": {"value": "<STRING>"}}}
//   IpcEvent::InboxReceived{..} -> {"Event": {"InboxReceived": {"payload_json": "<STRING>"}}}

import { Decoder, Encoder } from 'cbor-x';
import { connect, type Socket } from 'node:net';

export const MAGIC = Buffer.from('DAAK', 'ascii');

/** daak_ipc::IPC_MAX_FRAME. */
export const MAX_FRAME = 4 * 1024 * 1024;

/** daak_ipc::IPC_MAJOR / IPC_MINOR. High byte major, low byte minor. */
export const IPC_MAJOR = 1;
export const IPC_MINOR = 2;
export const IPC_VERSION = (IPC_MAJOR << 8) | IPC_MINOR;

// Measured against real Rust ciborium, not assumed:
//   useRecords:false     THE load-bearing encoder option. cbor-x's default
//                        tags a plain object with the record tag 0xd9dfff and
//                        ciborium rejects the frame with "invalid type:
//                        sequence, expected enum". Every other encoder
//                        option is irrelevant once this is set.
//   mapsAsObjects:true   Load-bearing, but on the DECODER: cbor-x's default
//                        returns Map objects, and `msg.Event` on a Map is
//                        undefined, which silently drops every event.
//   variableMapSize:true Defensive only. It forces definite-length headers
//                        (a1) so the bytes do not depend on this option; the
//                        indefinite b9 form only appears with useRecords:false
//                        and this unset.
const encoder = new Encoder({ mapsAsObjects: true, useRecords: false, variableMapSize: true });
const decoder = new Decoder({ mapsAsObjects: true });

export type IpcMessage = Record<string, unknown>;
export type IpcEvent = Record<string, Record<string, unknown>>;
export type IpcResponse =
  | 'Ok'
  | { Error: { message: string } }
  | { Json: { value: string } }
  | { Port: { port: number } }
  | { UpdateRequired: { min_major: number } };

/**
 * The peer speaks a major we do not. Not a transport failure: the UI shows an
 * "update required" affordance, so it needs a name and the minimum major.
 */
export class IpcVersionError extends Error {
  /** `undefined` means the frame carried no "v" at all. */
  constructor(readonly peerVersion: number | undefined) {
    super(
      peerVersion === undefined
        ? `daakd sent no IPC version; this build speaks major ${IPC_MAJOR}`
        : `daakd speaks IPC version 0x${peerVersion.toString(16)}; this build speaks major ${IPC_MAJOR}`,
    );
    this.name = 'IpcVersionError';
  }
}

/**
 * The daemon answered `UpdateRequired`: our major is too old for it. The
 * socket is fine, the app is not. `minMajor` is the lowest major the daemon
 * understands.
 */
export class IpcUpdateRequiredError extends Error {
  constructor(readonly minMajor: number) {
    super(`daakd needs IPC major ${minMajor}; update Daak`);
    this.name = 'IpcUpdateRequiredError';
  }
}

/** `version` defaults to ours; a test passes a foreign one to make a mismatch. */
export function encodeMessage(msg: IpcMessage, version: number = IPC_VERSION): Buffer {
  const body = Buffer.from(encoder.encode({ v: version, msg }));
  if (body.length > MAX_FRAME) throw new Error(`frame of ${body.length} bytes exceeds the ${MAX_FRAME} cap`);
  const head = Buffer.alloc(8);
  MAGIC.copy(head, 0);
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

/** Decode a whole frame: `{ v, msg }`. Callers want `.msg`. */
export function decodeFrame(frame: Buffer): { v?: number; msg: IpcMessage } {
  if (frame.length < 8 || !frame.subarray(0, 4).equals(MAGIC)) {
    throw new Error(`bad IPC magic in frame: ${Buffer.from(frame.subarray(0, 4)).toString('hex')}`);
  }
  const n = frame.readUInt32BE(4);
  if (n > MAX_FRAME) throw new Error(`frame of ${n} bytes exceeds the ${MAX_FRAME} cap`);
  if (frame.length < 8 + n) throw new Error(`frame claims ${n} bytes but carries ${frame.length - 8}`);
  const decoded = decoder.decode(frame.subarray(8, 8 + n)) as { v?: number; msg?: IpcMessage };
  // `v` is passed through as found, INCLUDING when absent: "v" is mandatory in
  // proto/ipc.cddl and Rust defaults a missing one to 0, which is not our
  // major. Defaulting to IPC_VERSION here would accept a version-less frame
  // the Rust half of this contract refuses. decodeMessage does the checking.
  return { v: decoded.v, msg: decoded.msg as IpcMessage };
}

/**
 * Decode a frame and refuse a major we do not implement. A peer on another
 * major cannot be understood, but its frame boundary is known, so the socket
 * stays usable -- the caller turns this into an "update required" prompt.
 */
export function decodeMessage(frame: Buffer): IpcMessage {
  const { v, msg } = decodeFrame(frame);
  // An ABSENT version is a pre-version peer, which is the same user-facing
  // outcome as a foreign major: we cannot understand this frame.
  if (v === undefined || v >> 8 !== IPC_MAJOR) throw new IpcVersionError(v);
  return msg;
}

/**
 * One request in flight at a time. The Rust side has NO request ids --
 * responses and events share the one stream -- so two concurrent requests
 * would race on which response belongs to whom. ponytail: the second one is
 * refused loudly rather than silently mismatched. Task 8 owns correlation ids.
 *
 * ponytail: NO reconnect. A dropped daemon surfaces as a rejected request plus
 * onClose; reconnection and daemon supervision belong to the app (Phase 7/8),
 * not to a transport that has no idea what a transfer is.
 */
export class IpcTransport {
  private buf = Buffer.alloc(0);
  private pending: { resolve: (r: IpcResponse) => void; reject: (e: Error) => void } | null = null;
  private closed: Error | null = null;
  onEvent: (ev: IpcEvent) => void = () => {};
  onClose: (e: Error) => void = () => {};

  private constructor(private sock: Socket) {
    sock.on('data', (c) => this.feed(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    sock.on('error', (e) => this.fail(e));
    sock.on('close', () => this.fail(new Error('daakd connection closed')));
  }

  static connect(sockPath: string): Promise<IpcTransport> {
    return new Promise((resolve, reject) => {
      const sock = connect(sockPath);
      const t = new IpcTransport(sock);
      sock.once('connect', () => resolve(t));
      sock.once('error', reject);
    });
  }

  async request(msg: IpcMessage): Promise<IpcResponse> {
    if (this.closed) throw this.closed;
    if (this.pending) throw new Error('one request at a time: the wire carries no request id');
    return new Promise<IpcResponse>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.sock.write(encodeMessage(msg));
    });
  }

  /** Fire-and-forget. Shutdown is the one request the daemon never answers. */
  send(msg: IpcMessage): void {
    this.sock.write(encodeMessage(msg));
  }

  close(): void { this.sock.destroy(); }

  private feed(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 8) return;
      // The socket chooses chunk boundaries, so the 8-byte header routinely
      // arrives before the body. Wait for the rest rather than treating it as
      // a protocol error -- getting this wrong tears the connection down at
      // random. Checked BEFORE decode so a short buffer never throws.
      const n = this.buf.readUInt32BE(4);
      if (n > MAX_FRAME) return this.fail(new Error(`frame of ${n} bytes exceeds the ${MAX_FRAME} cap`));
      if (this.buf.length < 8 + n) return;
      if (!this.buf.subarray(0, 4).equals(MAGIC)) return this.fail(new Error('bad IPC magic from daakd'));
      let msg: { Event?: IpcEvent; Response?: IpcResponse };
      try {
        msg = decodeMessage(this.buf) as typeof msg;
      } catch (e) {
        // A version mismatch is a NAMED condition, not a desync: the frame
        // boundary is known, so the stream stays usable and the caller learns
        // it must ask the user to update. Reject the request, keep the socket.
        if (e instanceof IpcVersionError) {
          this.buf = this.buf.subarray(8 + n);
          this.pending?.reject(e);
          this.pending = null;
          continue;
        }
        // Any other decode failure means the stream is desynchronised: we no
        // longer know where the next frame starts. Tear down rather than guess.
        this.fail(e as Error);
        return;
      }
      this.buf = this.buf.subarray(8 + n);
      if (msg.Event) { this.onEvent(msg.Event); continue; }
      const p = this.pending;
      if (!p) continue; // a response with no request in flight: drop it
      this.pending = null;
      if (msg.Response && typeof msg.Response === 'object' && 'UpdateRequired' in msg.Response) {
        // The daemon told us our version is too old, so this is an answer, not
        // a failure: hand it to the caller as a named error it can branch on.
        p.reject(
          new IpcUpdateRequiredError(msg.Response.UpdateRequired.min_major),
        );
      } else if (msg.Response && typeof msg.Response === 'object' && 'Error' in msg.Response) {
        p.reject(new Error(msg.Response.Error.message));
      } else {
        p.resolve((msg.Response ?? 'Ok') as IpcResponse);
      }
    }
  }

  private fail(e: Error): void {
    if (this.closed) return;
    this.closed = e;
    const p = this.pending;
    this.pending = null;
    p?.reject(e);
    this.onClose(e);
  }
}
