import { initialUiState, reduceUiState, type UiAction } from './store';

const device = (deviceId: string, name: string) => ({ deviceId, name, addr: '1.2.3.4:40001', online: true });
const entry = (payloadId: string) => ({ payloadId, transferId: 't', peerDeviceId: 'p', kind: 'text' as const, itemCount: 1, summary: 'msg', receivedAt: 0, savedPaths: [] });

describe('reduceUiState', () => {
  it('upserts a device without duplicating it', () => {
    const once = reduceUiState(initialUiState, { type: 'device.discovered', device: device('a', 'A') });
    const twice = reduceUiState(once, { type: 'device.discovered', device: device('a', 'A2') });
    expect(twice.devices).toHaveLength(1);
    expect(twice.devices[0].name).toBe('A2');
  });

  it('tracks transfer progress then marks done', () => {
    const p = reduceUiState(initialUiState, {
      type: 'transfer.progress', transferId: 't', bytesDone: 5, bytesTotal: 10,
    });
    expect(p.transfers[0]).toMatchObject({ transferId: 't', bytesDone: 5, state: 'active' });
    const done = reduceUiState(p, { type: 'transfer.done', transferId: 't' });
    expect(done.transfers[0].state).toBe('done');
  });

  it('prepends inbox entries newest-first', () => {
    const s = reduceUiState(
      reduceUiState(initialUiState, { type: 'inbox.received', payload: entry('1') }),
      { type: 'inbox.received', payload: entry('2') },
    );
    expect(s.inbox.map((i) => i.payloadId)).toEqual(['2', '1']);
  });

  // R7: `transfer.item` carries no byte counts and `pairing.*` is not a store
  // concern. The default arm must be a no-op, and must not throw on an event
  // shape this reducer was never compiled against.
  it('leaves state untouched for unhandled event types', () => {
    const s = reduceUiState(initialUiState, {
      type: 'transfer.item', transferId: 't', itemIndex: 0, state: 'receiving',
    });
    expect(s).toBe(initialUiState);
    expect(reduceUiState(s, { type: 'nope' } as never)).toBe(initialUiState);
  });

  // B1/F2: the engine's DeviceFound fires only on FIRST-EVER discovery (the
  // process-wide `is_new` map in engine.rs has no remover), so on the daemon
  // path every peer already on the LAN never emits one. devices() is the only
  // complete source, and it arrives as this internal action -- with no `online`
  // key, because no engine can put one there.
  it('takes the device list the engine hands over', () => {
    const s = reduceUiState(initialUiState, {
      type: 'devices.loaded',
      devices: [device('a', 'A'), device('b', 'B')],
    });
    expect(s.devices.map((d) => d.name)).toEqual(['A', 'B']);
  });

  // F2: the merge keeps what the snapshot does not mention, WITH its liveness.
  // A peer that announced and is not in the snapshot is not dropped, and the
  // online:true that device.discovered set is not stripped -- which is the
  // whole point, because the composer's gate reads exactly that field.
  it('merges the snapshot, keeping devices it does not mention and their liveness', () => {
    const discovered = reduceUiState(initialUiState, {
      type: 'device.discovered',
      device: { deviceId: 'z', name: 'Z', addr: '9.9.9.9:1', online: true },
    });
    const merged = reduceUiState(discovered, {
      type: 'devices.loaded',
      devices: [{ deviceId: 'a', name: 'A', addr: '1.2.3.4:40001' }],
    });
    expect(merged.devices.map((d) => d.name)).toEqual(['A', 'Z']);
    expect(merged.devices.find((d) => d.deviceId === 'z')?.online).toBe(true);
    // The snapshot is authoritative for what it DOES mention: name and addr
    // come from it, and it carries no `online`, so none is invented.
    expect(merged.devices.find((d) => d.deviceId === 'a')?.online).toBeUndefined();
  });

  it('does not duplicate a device the snapshot and the state share', () => {
    const discovered = reduceUiState(initialUiState, {
      type: 'device.discovered',
      device: { deviceId: 'a', name: 'A-old', addr: '1.1.1.1:1', online: true },
    });
    const merged = reduceUiState(discovered, {
      type: 'devices.loaded',
      devices: [{ deviceId: 'a', name: 'A-new', addr: '2.2.2.2:2' }],
    });
    expect(merged.devices).toHaveLength(1);
    expect(merged.devices[0].name).toBe('A-new');
    // The snapshot carries no `online` (no engine can put one there), so the
    // merge must carry the discovered liveness over rather than strip it.
    expect(merged.devices[0].online).toBe(true);
  });

  // R2: the DOMINANT path. Discovery inserts into the SAME map that
  // Engine::devices() drains, so a device that arrived via device.discovered is
  // ALWAYS in the snapshot -- and the snapshot has no `online` key. Taking the
  // snapshot's copy verbatim stripped the liveness the event had just set.
  it('keeps discovered liveness for a device the snapshot also contains', () => {
    const discovered = reduceUiState(initialUiState, {
      type: 'device.discovered',
      device: { deviceId: 'a', name: 'A', addr: '1.2.3.4:40001', online: true },
    });
    const merged = reduceUiState(discovered, {
      type: 'devices.loaded',
      devices: [{ deviceId: 'a', name: 'A', addr: '5.6.7.8:2' }],
    });
    expect(merged.devices).toHaveLength(1);
    expect(merged.devices[0].online).toBe(true);
    // The snapshot still owns everything else.
    expect(merged.devices[0].addr).toBe('5.6.7.8:2');
  });

  // Never invent liveness: an `online` the engine actually set wins over the
  // snapshot, including a negative one.
  it('lets the snapshot speak when it DOES carry online', () => {
    const discovered = reduceUiState(initialUiState, {
      type: 'device.discovered',
      device: { deviceId: 'a', name: 'A', addr: '1.2.3.4:40001', online: true },
    });
    const merged = reduceUiState(discovered, {
      type: 'devices.loaded',
      devices: [{ deviceId: 'a', name: 'A', addr: '1.2.3.4:40001', online: false }],
    });
    expect(merged.devices[0].online).toBe(false);
  });

  it('keeps a device the snapshot omits (note_peer seeds the map with no event)', () => {
    const discovered = reduceUiState(initialUiState, {
      type: 'device.discovered',
      device: { deviceId: 'z', name: 'Z', addr: '9.9.9.9:1', online: true },
    });
    const merged = reduceUiState(discovered, {
      type: 'devices.loaded',
      devices: [{ deviceId: 'a', name: 'A', addr: '1.2.3.4:40001' }],
    });
    expect(merged.devices.map((d) => d.name)).toEqual(['A', 'Z']);
    expect(merged.devices[1].online).toBe(true);
  });

  // F2/F3: the honest answer to "what should a repeat prime with an equal-
  // content snapshot do?" -- a NEW state object. sameDevices compares element
  // IDENTITY, and a second devices() is a fresh array of fresh entries, so the
  // reducer cannot prove the content matches without walking every field of
  // every device. Proving it would cost more than the one redundant notify it
  // saves, and prime() runs once after start(). Asserted here so the ceiling is
  // pinned rather than implied.
  it('rebuilds the state when a second distinct-but-equal snapshot arrives', () => {
    const one: UiAction = { type: 'devices.loaded', devices: [device('a', 'A')] };
    const two: UiAction = { type: 'devices.loaded', devices: [device('a', 'A')] };
    const once = reduceUiState(initialUiState, one);
    const twice = reduceUiState(once, two);
    expect(twice).not.toBe(once);
    expect(twice).toEqual(once);
  });

  it('keeps identity when the same array object is loaded twice', () => {
    const devices = [device('a', 'A')];
    const once = reduceUiState(initialUiState, { type: 'devices.loaded', devices });
    expect(reduceUiState(once, { type: 'devices.loaded', devices })).toBe(once);
  });
});
