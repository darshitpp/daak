import { describe, expect, it } from 'vitest';
import { encodeMessage, decodeMessage, IpcTransport, MAGIC, MAX_FRAME } from '../src/ipc/transport';
import { EventEmitter } from 'node:events';

// Real frames, 'DAAK' || u32 BE length || CBOR body, with the CBOR bodies
// produced by daak_ipc::write_message in a throwaway probe over the shipped
// enums -- NOT the plan's lowercase `kind` sketch, which does not exist on the
// wire. Only the magic and the length prefix are added here. Note serde encodes
// a UNIT variant as a bare string, so Subscribe is {"Request":"Subscribe"}.
const RUST_SUBSCRIBE =
  '4441414b00000013a1675265717565737469537562736372696265';
const RUST_OK = '4441414b0000000da168526573706f6e7365624f6b';
const RUST_ERROR =
  '4441414b00000028a168526573706f6e7365a1654572726f72a1676d6573736167656d756e696d706c656d656e746564';
const RUST_INBOX =
  '4441414b0000002ca1654576656e74a16d496e626f785265636569766564a16c7061796c6f61645f6a736f6e677b2261223a317d';

describe('ipc transport', () => {
  it('decodes the exact bytes daak-ipc writes for Subscribe', () => {
    expect(decodeMessage(Buffer.from(RUST_SUBSCRIBE, 'hex'))).toEqual({ Request: 'Subscribe' });
  });

  it('encodes a request the Rust side can decode', () => {
    expect(encodeMessage({ Request: 'Subscribe' }).toString('hex')).toBe(RUST_SUBSCRIBE);
  });

  it('round-trips a request the daemon answers', () => {
    const req = { Request: { Start: { data_dir: '', display_name: 'daak', listen_port: 0 } } };
    expect(decodeMessage(encodeMessage(req))).toEqual(req);
  });

  it('decodes a Rust unit response (serde encodes IpcResponse::Ok as "Ok")', () => {
    expect(decodeMessage(Buffer.from(RUST_OK, 'hex'))).toEqual({ Response: 'Ok' });
  });

  it('decodes a Rust error response', () => {
    expect(decodeMessage(Buffer.from(RUST_ERROR, 'hex'))).toEqual({ Response: { Error: { message: 'unimplemented' } } });
  });

  it('decodes InboxReceived with payload_json as a raw JSON string', () => {
    expect(decodeMessage(Buffer.from(RUST_INBOX, 'hex'))).toEqual({
      Event: { InboxReceived: { payload_json: '{"a":1}' } },
    });
  });

  it('rejects a frame above the 4 MiB cap instead of allocating it', () => {
    const head = Buffer.alloc(8);
    MAGIC.copy(head, 0);
    head.writeUInt32BE(MAX_FRAME + 1, 4);
    expect(() => decodeMessage(head)).toThrow(/cap/);
  });

  it('refuses to encode a frame above the cap', () => {
    const huge = { Request: { Send: { peer_device_id: 'd', text: 'x'.repeat(MAX_FRAME), files: [] } } };
    expect(() => encodeMessage(huge)).toThrow(/cap/);
  });

  it('rejects a bad magic', () => {
    expect(() => decodeMessage(Buffer.from('NOPE', 'ascii'))).toThrow(/magic/);
  });

  // The socket delivers arbitrary chunk boundaries, so a frame's 8-byte
  // header routinely arrives before its body. Treating that as a protocol
  // error tears the connection down at random (observed as an intermittent
  // contract-suite failure), so the transport must WAIT for the rest.
  function fakeTransport() {
    const sock = new EventEmitter() as EventEmitter & { write: (b: Buffer) => void; destroy: () => void };
    const written: Buffer[] = [];
    sock.write = (b) => { written.push(b); return true; };
    sock.destroy = () => {};
    // The constructor is private for callers; a test drives the same path.
    const t = new (IpcTransport as unknown as new (s: unknown) => IpcTransport)(sock);
    return { t, sock, written };
  }

  it('waits for a body that arrives after the header instead of failing', async () => {
    const { t, sock } = fakeTransport();
    const frame = encodeMessage({ Response: 'Ok' });
    const p = t.request({ Request: 'Devices' });
    sock.emit('data', frame.subarray(0, 8));
    await new Promise((r) => setTimeout(r, 5));
    sock.emit('data', frame.subarray(8));
    expect(await p).toBe('Ok');
  });

  it('splits two frames arriving in one chunk', async () => {
    const { t, sock } = fakeTransport();
    const p = t.request({ Request: 'Devices' });
    const both = Buffer.concat([encodeMessage({ Response: { Json: { value: '[]' } } }), encodeMessage({ Response: 'Ok' })]);
    sock.emit('data', both);
    // The first frame is the answer; the trailing one has no request and is
    // dropped, which is what the one-request-at-a-time rule implies.
    expect(await p).toEqual({ Json: { value: '[]' } });
  });

  it('refuses a second concurrent request loudly', async () => {
    const { t } = fakeTransport();
    void t.request({ Request: 'Devices' });
    await expect(t.request({ Request: 'Devices' })).rejects.toThrow(/one request at a time/);
  });

  it('rejects the in-flight request when the connection drops', async () => {
    const { t, sock } = fakeTransport();
    const p = t.request({ Request: 'Devices' });
    sock.emit('close');
    await expect(p).rejects.toThrow(/closed/);
    await expect(t.request({ Request: 'Devices' })).rejects.toThrow(/closed/);
  });

  it('tells onClose once, not on every later socket event', async () => {
    const { t, sock } = fakeTransport();
    let closes = 0;
    t.onClose = () => { closes += 1; };
    sock.emit('close');
    sock.emit('error', new Error('EPIPE'));
    expect(closes).toBe(1);
  });
});
