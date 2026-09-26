import { expect, it } from 'vitest';
import type { DaakEngine } from '../src/engine/types';

// The assertions BOTH engines must satisfy today, in Task 7.
//
// Deliberately NOT here, and deferred to Task 9 (which wires the real engine
// into daakd and the UDL):
//   - send() returning a transfer id. daakd answers IpcRequest::Send with
//     Error{"unimplemented"} and no engine exists behind it, so there is
//     nothing honest to assert. Task 9 adds it back for both engines.
//   - pair() returning a sas. Same reason: Pair is not on daakd's dispatch
//     table at all, and the FFI has no manual-code method.
//   - listTransfers/listInbox/cancel/retry/setDisplayName/setPresence against
//     a LIVE engine. The TS methods are written and pinned by
//     daemon-client.spec.ts against the real wire shapes; only their engine
//     backing is missing. Task 9's contract-suite edit is where they rejoin
//     this suite, alongside the listTransfers(filter) signature change.
// ponytail: adding a `skipped`/`todo` entry per deferred method would be a
// parallel list to drift out of sync; this comment is the list.
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
}
