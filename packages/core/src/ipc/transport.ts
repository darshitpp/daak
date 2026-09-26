// The DAAK IPC wire format as daak-ipc actually implements it -- NOT the plan's
// lowercase `kind` sketch, which does not exist on the wire:
//
//   frame = 'DAAK' || u32 BE length || CBOR(IpcMessage)
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

// All three options are load-bearing and none is cbor-x's default:
//   useRecords:false     cbor-x otherwise tags a plain object as a record
//                        (0xd9dfff83) and ciborium rejects the frame with
//                        "invalid type: sequence, expected enum".
//   variableMapSize:true definite-length map headers (a1), which is what serde
//                        emits; cbor-x's default is the b9 indefinite form.
//   mapsAsObjects:true   serde maps decode to plain objects, not Maps.
const encoder = new Encoder({ mapsAsObjects: true, useRecords: false, variableMapSize: true });
const decoder = new Decoder({ mapsAsObjects: true });

export type IpcMessage = Record<string, unknown>;
export type IpcEvent = Record<string, Record<string, unknown>>;
export type IpcResponse =
  | 'Ok'
  | { Error: { message: string } }
  | { Json: { value: string } }
  | { Port: { port: number } };

export function encodeMessage(msg: IpcMessage): Buffer {
  const body = Buffer.from(encoder.encode(msg));
  if (body.length > MAX_FRAME) throw new Error(`frame of ${body.length} bytes exceeds the ${MAX_FRAME} cap`);
  const head = Buffer.alloc(8);
  MAGIC.copy(head, 0);
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

export function decodeMessage(frame: Buffer): IpcMessage {
  if (frame.length < 8 || !frame.subarray(0, 4).equals(MAGIC)) {
    throw new Error(`bad IPC magic in frame: ${Buffer.from(frame.subarray(0, 4)).toString('hex')}`);
  }
  const n = frame.readUInt32BE(4);
  if (n > MAX_FRAME) throw new Error(`frame of ${n} bytes exceeds the ${MAX_FRAME} cap`);
  if (frame.length < 8 + n) throw new Error(`frame claims ${n} bytes but carries ${frame.length - 8}`);
  return decoder.decode(frame.subarray(8, 8 + n)) as IpcMessage;
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
        // A desynchronised stream is unrecoverable: we no longer know where the
        // next frame starts. Tear the connection down rather than guess.
        this.fail(e as Error);
        return;
      }
      this.buf = this.buf.subarray(8 + n);
      if (msg.Event) { this.onEvent(msg.Event); continue; }
      const p = this.pending;
      if (!p) continue; // a response with no request in flight: drop it
      this.pending = null;
      if (msg.Response && typeof msg.Response === 'object' && 'Error' in msg.Response) {
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
