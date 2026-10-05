import { expect, it } from 'vitest';
import type { DaakEngine } from '../src/engine/types';

// The assertions BOTH engines must satisfy. Every method in the interface is
// exercised here against the in-process TurboModule and against the real
// daakd binary, so a divergence in either deployment is a test failure and
// not a note in a comment.
//
// Deliberately NOT here, and why:
//   - pair() needs a second daakd on the LAN to pair WITH, which is a
//     two-machine scenario no local test can create. The request shape and the
//     refusal of an unknown device / a manual code are pinned by
//     daemon-client.spec.ts and contract.spec.ts instead.
//   - send()'s row is asserted in the daemon-backed spec only, because the
//     in-process engine here runs against a FAKE native module that has no
//     SQLite behind it.
//   - armHostPairing() is MOBILE-ONLY BY RULING, not by oversight. It arms the
//     engine's accept slot, which lives inside the in-process engine; exposing
//     it on the daemon would mean a new IpcRequest variant, which the C2 brief
//     forbids (and a new request is what owes an IPC_MINOR bump).
//     DaemonClientEngine therefore REJECTS it loudly rather than no-oping -- a
//     silent no-op would leave a desktop host
//     showing a QR that accepts nothing, which is the bug C2 was raised for.
//     So it is deliberately NOT in the shared list below; the in-process arm is
//     pinned by contract.spec.ts and the daemon rejection by
//     daemon-client.spec.ts. The method-set pin at the top of this file still
//     requires BOTH engines to expose it, which is the real cross-engine
//     contract; what differs is behaviour, and that is engine-specific.
export function runContractSuite(name: string, factory: () => Promise<DaakEngine>): void {
  it(`${name}: exposes the full DaakEngine method set`, async () => {
    const e = await factory();
    const methods: (keyof DaakEngine)[] = [
      'start', 'stop', 'devices', 'pair', 'send', 'cancel',
      'retry', 'quarantineReport', 'deleteQuarantined', 'listQuarantineReports',
      'listTransfers', 'listInbox', 'setDisplayName', 'setPresence', 'on',
      'armHostPairing', 'selfProfile',
    ];
    for (const m of methods) expect(typeof e[m], `${name}.${m}`).toBe('function');
    await e.stop();
  });

  // The host arm is the ONE method whose correct behaviour DIFFERS per engine,
  // so it cannot be a shared assertion. Rather than leave that as a note, it is
  // here as a branch: both engines are asked to arm, and each must answer
  // correctly for its own deployment. A future IpcRequest would flip the daemon
  // branch to resolve, and this test would then hold them to the same contract.
  it(`${name}: armHostPairing answers correctly for this deployment`, async () => {
    const e = await factory();
    await e.start();
    if (name === 'daemon') {
      // Mobile-only ruling, asserted rather than commented.
      await expect(e.armHostPairing()).rejects.toThrow(/mobile-only/);
    } else {
      // The in-process engine arms its accept slot. There is no peer yet, so
      // this must NOT throw and must NOT invent a pairing.
      await expect(e.armHostPairing()).resolves.toBeUndefined();
    }
    await e.stop();
  });

  it(`${name}: start is idempotent and stop is safe`, async () => {
    const e = await factory();
    await e.start();
    await e.start();
    await e.stop();
    // stop() twice must not hang or throw; a desktop app calls it on unmount
    // and again from a shutdown handler.
    await e.stop();
  });

  it(`${name}: devices returns a DeviceInfo[]`, async () => {
    const e = await factory();
    await e.start();
    const d = await e.devices();
    expect(Array.isArray(d)).toBe(true);
    for (const dev of d) expect(typeof dev.deviceId).toBe('string');
    await e.stop();
  });

  it(`${name}: on() returns a disposer that stops delivery`, async () => {
    const e = await factory();
    const seen: unknown[] = [];
    const off = e.on((ev) => seen.push(ev));
    expect(typeof off).toBe('function');
    off();
    expect(seen).toEqual([]);
    await e.stop();
  });

  // The plan's Step 1 snippet cancelled the all-zero id and expected success,
  // but the Phase 3 ruling (R-T10-3) outranks it: every UPDATE in cancel/retry
  // matches zero rows for an unknown id, so without the require_outbox guard
  // both would report success for a row that does not exist. A well-formed id
  // with no row is therefore an ERROR on both engines. The POSITIVE half -- a
  // real queued row cancelled through the daemon -- lives in
  // daemon.contract.spec.ts, because the in-process engine here runs against a
  // fake native module with no SQLite behind it.
  it(`${name}: cancel and retry reject an unknown id`, async () => {
    const e = await factory();
    await e.start();
    await expect(e.cancel('00'.repeat(16))).rejects.toThrow();
    await expect(e.retry('00'.repeat(16))).rejects.toThrow();
    // A malformed id is refused too, for the same reason.
    await expect(e.cancel('not-hex')).rejects.toThrow();
    await expect(e.retry('not-hex')).rejects.toThrow();
    await e.stop();
  });

  it(`${name}: listTransfers accepts a filter`, async () => {
    const e = await factory();
    await e.start();
    const all = await e.listTransfers();
    expect(Array.isArray(all)).toBe(true);
    // 'queued' is spec 4.2's transfers.state for a re-armed/queued send;
    // 'pending' is OUTBOX vocabulary and is not a member of that enum, so
    // filtering on it is vacuous.
    //
    // B1: these two are the assertion that would have caught the silently
    // dropped `peerDeviceId` key -- `Array.isArray` was true for the WHOLE
    // TABLE, which is what a dropped key produces. A filter that cannot match
    // must come back EMPTY, on both engines.
    expect(await e.listTransfers({ peerDeviceId: '00'.repeat(16) })).toEqual([]);
    expect(await e.listTransfers({ state: 'no-such-state' })).toEqual([]);
    const filtered = await e.listTransfers({ state: 'queued', peerDeviceId: '00'.repeat(16) });
    expect(filtered).toEqual([]);
    await e.stop();
  });

  it(`${name}: listInbox, setDisplayName and setPresence wire through`, async () => {
    const e = await factory();
    await e.start();
    expect(Array.isArray(await e.listInbox())).toBe(true);
    await e.setDisplayName('renamed');
    // The READ half, and the two names it must keep separate. A rename
    // re-resolves the name against the LAN, so a prefix is all a test can
    // demand of `name`: a collision renames to "<Adjective> <Animal> · <base>"
    // (naming::unique_display_name), so the DECIDED name can carry a PREFIX,
    // not a suffix. That resolved name is the one peers see. It is not
    // anchored: this suite runs the in-process engine and a spawned daakd at
    // the same time, and two engines both renamed "renamed" on one LAN collide
    // for real, which is exactly the resolution the assertion has to tolerate.
    //
    // `baseName` is the OTHER half of the same read: the name the user typed
    // and the settings file holds, never prefixed. A Settings box shows THIS,
    // so it is asserted exactly -- a collision changes `name` and leaves
    // `baseName` alone.
    const self = await e.selfProfile();
    expect(self.name).toMatch(/renamed/);
    expect(self.baseName).toBe('renamed');
    // 32 hex chars, like every id on this API.
    expect(self.deviceId).toMatch(/^[0-9a-f]{32}$/i);
    // The id is THIS device's, so it is stable across the rename.
    expect((await e.selfProfile()).deviceId).toBe(self.deviceId);
    await e.setPresence('away');
    await e.stop();
  });

  // The quarantine surface, on both engines. The KEY assertion is the empty
  // one: a fresh engine holds nothing, so `listQuarantineReports()` must answer
  // `[]`. A bridge that returned `null`, threw, or answered an object instead
  // all fail here, and the History screen's "nothing is held back" is decided
  // by exactly this answer.
  //
  // Deliberately NOT here: the shape of a report with a REAL held file. That
  // needs a second engine sending a manifest whose declared hash disagrees with
  // its bytes, which is a two-machine scenario -- so it lives in
  // crates/daak-core/tests/quarantine.rs, against the engine that really
  // quarantines. What is pinned HERE is that both bridges agree on an empty
  // answer and on the shape of the selector, which is what can drift.
  it(`${name}: the quarantine surface is reachable and empty when nothing is held`, async () => {
    const e = await factory();
    await e.start();
    expect(await e.listQuarantineReports()).toEqual([]);
    // And a read of a specific item REJECTS rather than resolving to a blank
    // report: every lookup behind it matches zero rows for an unknown id, so
    // without the explicit check it would render a screen of invented nulls.
    await expect(e.quarantineReport('00'.repeat(16), 0)).rejects.toThrow();
    await expect(e.deleteQuarantined('00'.repeat(16), 0)).rejects.toThrow();
    await e.stop();
  });
}
