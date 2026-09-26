// The DaemonClientEngine against a FAKE transport: no daakd, no privileges.
// This pins the request/response mapping to the real daak-ipc wire shapes; the
// round trip against the real binary is daemon.contract.spec.ts.
import { describe, expect, it } from 'vitest';
import { DaemonClientEngine, IpcUpdateRequiredError } from '../src/engine/DaemonClient';
import type { IpcEvent, IpcMessage, IpcResponse } from '../src/ipc/transport';

function makeEngine() {
  const written: IpcMessage[] = [];
  const sent: IpcMessage[] = [];
  // A request may itself issue another request (start -> Start then
  // Subscribe; pair -> Devices then Pair), and those are separate microtasks,
  // so the fake keeps a QUEUE of pending requests and hands out replies in
  // arrival order. The transport has no request ids, so ordering IS the
  // contract this pins.
  const pending: ((r: IpcResponse) => void)[] = [];
  const queued: IpcResponse[] = [];
  const drain = () => {
    while (pending.length > 0 && queued.length > 0) {
      (pending.shift() as (r: IpcResponse) => void)(queued.shift() as IpcResponse);
    }
  };
  const tx = {
    // IpcTransport exposes onEvent/onClose as ASSIGNABLE properties, and the
    // engine assigns over them, so the fake must be an object literal too.
    onEvent: (_ev: IpcEvent) => {},
    onClose: () => {},
    send: (m: IpcMessage) => { sent.push(m); },
    request: (m: IpcMessage) => {
      written.push(m);
      return new Promise<IpcResponse>((resolve) => {
        pending.push(resolve);
        drain();
      });
    },
    close: () => {},
  };
  return {
    engine: new DaemonClientEngine(tx as never),
    written,
    sent,
    // Answer the requests that are in flight, in arrival order, and remember
    // any extra for requests that have not been issued yet.
    reply: (...rs: IpcResponse[]) => {
      queued.push(...rs);
      drain();
    },
    event: (ev: IpcEvent) => tx.onEvent(ev),
  };
}

describe('DaemonClientEngine', () => {
  it('sends Start (which creates the engine) then subscribes', async () => {
    // Start MUST come first: every other request answers
    // Error{engine not started} until it lands, and the event stream is only
    // fanned out to a connection that has sent Subscribe.
    const h = makeEngine();
    const p = h.engine.start();
    h.reply('Ok', 'Ok');
    await p;
    expect(h.written).toEqual([
      { Request: { Start: { data_dir: expect.any(String), display_name: 'daak', listen_port: 0 } } },
      { Request: 'Subscribe' },
    ]);
  });

  it('is safe to start twice: one Start, two Subscribes', async () => {
    // A second Start with the same args is a daemon no-op (a different one
    // would be refused), so the client tracks its own args and does not resend.
    const h = makeEngine();
    const a = h.engine.start();
    h.reply('Ok', 'Ok');
    await a;
    // The fake settles one request at a time, so Start's own reply is already
    // the first 'Ok'; the second start() only writes Subscribe.
    const b = h.engine.start();
    h.reply('Ok');
    await b;
    expect(h.written).toEqual([
      { Request: { Start: { data_dir: expect.any(String), display_name: 'daak', listen_port: 0 } } },
      { Request: 'Subscribe' },
      { Request: 'Subscribe' },
    ]);
  });

  it('encodes Start with the snake_case keys Rust actually deserialises', async () => {
    // The casing is the whole contract here: cbor-x writes JS property names
    // verbatim and IpcRequest has no rename_all, so a camelCase key is a serde
    // error on the daemon, not a tolerated spelling. Assert on the real
    // encoded bytes (the transport's own encoder settings) rather than on the
    // object, because the object is what hid the bug.
    const h = makeEngine();
    const p = h.engine.start();
    h.reply('Ok', 'Ok');
    await p;
    const { Encoder } = await import('cbor-x');
    const enc = new Encoder({ mapsAsObjects: true, useRecords: false, variableMapSize: true });
    const startMsg = h.written[0] as { Request: { Start: Record<string, unknown> } };
    const bytes = Buffer.from(enc.encode({ v: 256, msg: startMsg })).toString('hex');
    // data_dir / display_name / listen_port, spelled exactly as Rust spells them.
    expect(bytes).toContain(Buffer.from('data_dir').toString('hex'));
    expect(bytes).toContain(Buffer.from('display_name').toString('hex'));
    expect(bytes).toContain(Buffer.from('listen_port').toString('hex'));
    expect(bytes).not.toContain(Buffer.from('dataDir').toString('hex'));
  });

  it('parses the Json response value as JSON, not as an object', async () => {
    const h = makeEngine();
    const p = h.engine.devices();
    h.reply({ Json: { value: '[{"deviceId":"d1","name":"peer","addr":"10.0.0.2:9000"}]' } });
    expect(await p).toEqual([{ deviceId: 'd1', name: 'peer', addr: '10.0.0.2:9000' }]);
    expect(h.written).toEqual([{ Request: 'Devices' }]);
  });

  it('does NOT record startedWith when Start itself failed', async () => {
    // A Start refused by the daemon (a bad data_dir, a conflicting engine)
    // must leave the client willing to try again. Recording the args BEFORE the
    // await meant every later start() skipped Start and went straight to
    // Subscribe, so the client was stuck on "engine not started" forever.
    // The transport REJECTS an IpcResponse::Error, so the fake transport is
    // built with a rejecting `request`, which is the one thing makeEngine's
    // reply/fail queue cannot express for a request the client has not made
    // yet.
    const written: IpcMessage[] = [];
    const engine = new DaemonClientEngine({
      onEvent: () => {},
      onClose: () => {},
      send: () => {},
      close: () => {},
      request: (m: IpcMessage) => {
        written.push(m);
        return Promise.reject(new Error('engine already started with different arguments'));
      },
    } as never);

    await expect(engine.start()).rejects.toThrow(/already/);
    expect(written).toEqual([{ Request: { Start: expect.anything() } }]);
  });

  it('names the protocol error when a non-Json reply arrives (I-2)', async () => {
    // A bare Ok used to come back as the string 'null', so send() died with a
    // null-deref and listInbox() could hand back null typed as an array.
    const h = makeEngine();
    const p = h.engine.devices();
    h.reply('Ok');
    await expect(p).rejects.toThrow(/expected a Json response, got "Ok"/);
  });

  it('rejects a devices payload that is not an array', async () => {
    const h = makeEngine();
    const p = h.engine.devices();
    h.reply({ Json: { value: '{}' } });
    await expect(p).rejects.toThrow(/array/);
  });

  it('surfaces UpdateRequired as a NAMED error the UI can catch', async () => {
    // A major-version mismatch is not a transport failure the UI should show
    // as "something went wrong"; it means "update the app". Give it a class
    // and a machine-readable minMajor so a shell can branch on it.
    const h = makeEngine();
    const p = h.engine.devices();
    h.reply({ UpdateRequired: { min_major: 2 } });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IpcUpdateRequiredError);
    expect((err as IpcUpdateRequiredError).minMajor).toBe(2);
    expect((err as Error).message).toMatch(/update/i);
  });

  it('pairs by qr: resolves the addr and sends the bundle as a Buffer (bstr, not array)', async () => {
    const h = makeEngine();
    // pair() issues Devices first, then Pair: two requests, so two replies in
    // arrival order.
    const p = h.engine.pair('d1', 'qr', 'a1b2');
    h.reply(
      { Json: { value: '[{"deviceId":"d1","name":"peer","addr":"10.0.0.2:9000"}]' } },
      { Json: { value: '{"sas":"1-2-3","peer_device_id":"d1"}' } },
    );
    expect(await p).toEqual({ sas: '1-2-3' });
    expect(h.written[1]).toEqual({
      Request: { Pair: { addr: '10.0.0.2:9000', bundle_cbor: Buffer.from([0xa1, 0xb2]) } },
    });
    // A number[] would encode as a CBOR ARRAY; daak-ipc deserialises
    // bundle_cbor as a bstr (R27), so the value must be a Buffer.
    expect(Buffer.isBuffer((h.written[1].Request as never as { Pair: { bundle_cbor: unknown } }).Pair.bundle_cbor)).toBe(true);
  });

  it('refuses a manual code and an unknown device instead of sending a doomed request', async () => {
    const h = makeEngine();
    await expect(h.engine.pair('d1', 'code', '123456')).rejects.toThrow(/manual-code/);
    const q = h.engine.pair('nope', 'qr', 'a1b2');
    h.reply({ Json: { value: '[]' } });
    await expect(q).rejects.toThrow(/nope/);
    await expect(h.engine.pair('d1', 'qr')).rejects.toThrow(/bundle/);
    // Only the code-mode and no-bundle refusals send nothing; resolving the
    // device id legitimately needs a Devices request first (R13).
    expect(h.written).toEqual([{ Request: 'Devices' }]);
  });

  it('refuses a send with neither text nor files', async () => {
    const h = makeEngine();
    await expect(h.engine.send({ peerDeviceId: 'd1' })).rejects.toThrow(/empty/);
    expect(h.written).toEqual([]);
  });

  it('refuses a send carrying both text and files (I2, same rule as InProcess)', async () => {
    const h = makeEngine();
    await expect(h.engine.send({ peerDeviceId: 'd1', text: 'hi', files: ['/a'] })).rejects.toThrow(/not both/);
  });

  it('sends Send in IpcRequest::Send shape and reads transferId + queued back', async () => {
    const h = makeEngine();
    const p = h.engine.send({ peerDeviceId: 'd1', text: 'hi' });
    h.reply({ Json: { value: '{"transferId":"t1","queued":true}' } });
    expect(await p).toEqual({ transferId: 't1', queued: true });
    expect(h.written).toEqual([{ Request: { Send: { peer_device_id: 'd1', text: 'hi', files: [] } } }]);
  });

  it('sends the remaining requests in their IpcRequest shapes', async () => {
    const h = makeEngine();
    const calls: [() => Promise<void>, IpcResponse][] = [
      [() => h.engine.cancel('t1'), 'Ok'],
      [() => h.engine.retry('t1'), 'Ok'],
      [() => h.engine.setDisplayName('renamed'), 'Ok'],
      [() => h.engine.setPresence('away'), 'Ok'],
    ];
    for (const [call, reply] of calls) {
      const p = call();
      h.reply(reply);
      await p;
    }
    expect(h.written).toEqual([
      { Request: { Cancel: { transfer_id: 't1' } } },
      { Request: { Retry: { transfer_id: 't1' } } },
      { Request: { SetDisplayName: { name: 'renamed' } } },
      { Request: { SetPresence: { state: 'away' } } },
    ]);
  });

  it('lists transfers and the inbox as arrays', async () => {
    const h = makeEngine();
    const a = h.engine.listTransfers();
    h.reply({ Json: { value: '[]' } });
    expect(await a).toEqual([]);
    expect(h.written).toEqual([{ Request: { ListTransfers: { filter: null } } }]);

    const b = h.engine.listTransfers({ state: 'pending', peerDeviceId: '00'.repeat(16) });
    h.reply({ Json: { value: '[]' } });
    expect(await b).toEqual([]);
    expect(h.written[1]).toEqual({
      Request: {
        // B1: snake_case. The TS type is camelCase but cbor-x writes property
        // names VERBATIM and IpcRequest has no rename_all, so peerDeviceId on
        // the wire is dropped by serde and the peer filter becomes None -- a
        // whole-table list. TransferFilter is now deny_unknown_fields, so this
        // casing is a decode ERROR instead.
        ListTransfers: { filter: { state: 'pending', peer_device_id: '00'.repeat(16) } },
      },
    });

    const c = h.engine.listInbox();
    h.reply({ Json: { value: '[]' } });
    expect(await c).toEqual([]);
  });

  it('shuts the daemon down on stop() without waiting for a response', async () => {
    // Shutdown closes the connection and the daemon sends nothing back.
    const h = makeEngine();
    await h.engine.stop();
    expect(h.sent).toEqual([{ Request: 'Shutdown' }]);
    expect(h.written).toEqual([]);
  });

  it('maps a snake_case IpcEvent onto every arm the daemon can emit', () => {
    const h = makeEngine();
    const seen: unknown[] = [];
    h.engine.on((e) => seen.push(e));
    h.event({ DeviceFound: { device_id: 'd1', name: 'peer', addr: '10.0.0.2:9000' } });
    h.event({ DeviceState: { device_id: 'd1', online: true } });
    h.event({ DeviceState: { device_id: 'd2', online: false } });
    h.event({ PairingSas: { peer_device_id: 'd1', sas: '1-2-3' } });
    h.event({ TransferProgress: { transfer_id: 't1', bytes_done: 5, bytes_total: 10 } });
    h.event({ TransferItem: { transfer_id: 't1', item_index: 1, state: 'receiving', dest_path: '/a' } });
    h.event({ TransferDone: { transfer_id: 't1' } });
    h.event({ TransferFailed: { transfer_id: 't1', error: 'boom' } });
    expect(seen).toEqual([
      { type: 'device.discovered', device: { deviceId: 'd1', name: 'peer', addr: '10.0.0.2:9000' } },
      { type: 'device.state', deviceId: 'd1', state: 'online' },
      { type: 'device.state', deviceId: 'd2', state: 'offline' },
      { type: 'pairing.sas', peerDeviceId: 'd1', sas: '1-2-3' },
      { type: 'transfer.progress', transferId: 't1', bytesDone: 5, bytesTotal: 10 },
      { type: 'transfer.item', transferId: 't1', itemIndex: 1, state: 'receiving', destPath: '/a' },
      { type: 'transfer.done', transferId: 't1' },
      { type: 'transfer.failed', transferId: 't1', error: 'boom' },
    ]);
  });

  it('JSON.parses InboxReceived payload_json, which the wire carries as a STRING', () => {
    const h = makeEngine();
    const seen: unknown[] = [];
    h.engine.on((e) => seen.push(e));
    h.event({ InboxReceived: { payload_json: JSON.stringify({ payloadId: 'p1', itemCount: 2 }) } });
    expect(seen).toEqual([{ type: 'inbox.received', payload: { payloadId: 'p1', itemCount: 2 } }]);
  });

  it('drops an unmappable event and an unparseable payload instead of lying to the UI', () => {
    const h = makeEngine();
    const seen: unknown[] = [];
    h.engine.on((e) => seen.push(e));
    h.event({ NotAThing: { x: 1 } });
    h.event({ InboxReceived: { payload_json: 'not json' } });
    expect(seen).toEqual([]);
  });

  it('unsubscribes on the returned disposer', () => {
    const h = makeEngine();
    const seen: unknown[] = [];
    const off = h.engine.on((e) => seen.push(e));
    off();
    h.event({ TransferDone: { transfer_id: 't1' } });
    expect(seen).toEqual([]);
  });
});
