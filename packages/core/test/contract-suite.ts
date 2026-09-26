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
export function runContractSuite(name: string, factory: () => Promise<DaakEngine>): void {
  it(`${name}: exposes the full DaakEngine method set`, async () => {
    const e = await factory();
    const methods: (keyof DaakEngine)[] = [
      'start', 'stop', 'devices', 'pair', 'send', 'cancel',
      'retry', 'listTransfers', 'listInbox', 'setDisplayName', 'setPresence', 'on',
    ];
    for (const m of methods) expect(typeof e[m], `${name}.${m}`).toBe('function');
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
    const filtered = await e.listTransfers({ state: 'pending', peerDeviceId: '00'.repeat(16) });
    expect(Array.isArray(filtered)).toBe(true);
    await e.stop();
  });

  it(`${name}: listInbox, setDisplayName and setPresence wire through`, async () => {
    const e = await factory();
    await e.start();
    expect(Array.isArray(await e.listInbox())).toBe(true);
    await e.setDisplayName('renamed');
    await e.setPresence('away');
    await e.stop();
  });
}
