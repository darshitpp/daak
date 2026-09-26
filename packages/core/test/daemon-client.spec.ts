// The DaemonClientEngine against a FAKE transport: no daakd, no privileges.
// This pins the request/response mapping to the real daak-ipc wire shapes; the
// round trip against the real binary is daemon.contract.spec.ts.
import { describe, expect, it } from 'vitest';
import { DaemonClientEngine } from '../src/engine/DaemonClient';
import type { IpcEvent, IpcMessage, IpcResponse } from '../src/ipc/transport';

function makeEngine() {
  const written: IpcMessage[] = [];
  const sent: IpcMessage[] = [];
  let settle: (r: IpcResponse) => void = () => {};
  const tx = {
    // IpcTransport exposes onEvent/onClose as ASSIGNABLE properties, and the
    // engine assigns over them, so the fake must be an object literal too.
    onEvent: (_ev: IpcEvent) => {},
    onClose: () => {},
    send: (m: IpcMessage) => { sent.push(m); },
    request: (m: IpcMessage) => {
      written.push(m);
      return new Promise<IpcResponse>((resolve) => { settle = resolve; });
    },
    close: () => {},
  };
  return {
    engine: new DaemonClientEngine(tx as never),
    written,
    sent,
    reply: (r: IpcResponse) => settle(r),
    event: (ev: IpcEvent) => tx.onEvent(ev),
  };
}

describe('DaemonClientEngine', () => {
  it('subscribes on start, and does NOT send IpcRequest::Start', async () => {
    // IpcRequest::Start exists, but daakd answers it Error{unimplemented}
    // until Task 9 wires the engine, so a client that sent it could never
    // start. Task 9 restores it once the daemon owns an engine.
    const h = makeEngine();
    const p = h.engine.start();
    h.reply('Ok');
    await p;
    expect(h.written).toEqual([{ Request: 'Subscribe' }]);
  });

  it('is safe to start twice (a second Subscribe is idempotent)', async () => {
    const h = makeEngine();
    const a = h.engine.start();
    h.reply('Ok');
    await a;
    const b = h.engine.start();
    h.reply('Ok');
    await b;
    expect(h.written).toEqual([{ Request: 'Subscribe' }, { Request: 'Subscribe' }]);
  });

  it('parses the Json response value as JSON, not as an object', async () => {
    const h = makeEngine();
    const p = h.engine.devices();
    h.reply({ Json: { value: '[{"deviceId":"d1","name":"peer","addr":"10.0.0.2:9000"}]' } });
    expect(await p).toEqual([{ deviceId: 'd1', name: 'peer', addr: '10.0.0.2:9000' }]);
    expect(h.written).toEqual([{ Request: 'Devices' }]);
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

  it('refuses a qr or code pair instead of sending a request daakd cannot serve', async () => {
    const h = makeEngine();
    await expect(h.engine.pair('d1', 'qr', 'a1b2')).rejects.toThrow(/Task 9/);
    await expect(h.engine.pair('d1', 'code', '123456')).rejects.toThrow(/Task 9/);
    expect(h.written).toEqual([]);
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
    const b = h.engine.listInbox();
    h.reply({ Json: { value: '[]' } });
    expect(await b).toEqual([]);
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
