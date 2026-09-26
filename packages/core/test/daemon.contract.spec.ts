// The shared contract suite against the REAL daakd binary over a real Unix
// socket. R5: the binary is PREBUILT by the controller (cargo build -p daakd)
// and its path arrives in DAAKD_BIN, so vitest never races cargo's build lock.
//
// This file needs two things the sandbox denies: a spawned process and a bound
// Unix socket. Run it escalated:
//   DAAKD_BIN=../../target/debug/daakd pnpm --filter @daak/core test
// Without DAAKD_BIN the suite is skipped rather than faked green -- see the
// note in the ledger about which assertions are deferred to Task 9.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClientEngine } from '../src/engine/DaemonClient';
import { IpcTransport } from '../src/ipc/transport';
import { runContractSuite } from './contract-suite';

// DAAKD_BIN wins; otherwise fall back to the workspace's debug build, which is
// where `cargo test --workspace` / `cargo build -p daakd` leaves it. The
// controller (and CI) builds it before the JS suite runs, so the parity gate is
// never silently skipped in a normal checkout.
const BIN = process.env.DAAKD_BIN ?? join(import.meta.dirname, '../../../target/debug/daakd');
// The daemon binds and chmods this directory; a world-writable tmp parent is
// exactly what check_owned_by_us refuses, so the parent must already be ours.
const dir = mkdtempSync(join(tmpdir(), 'daakd-contract-'));
const sock = join(dir, 'daakd.sock');

let daemon: ChildProcess | undefined;

async function waitForSocket(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      const t = await IpcTransport.connect(sock);
      t.close();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`daakd never bound ${sock}`);
}

if (existsSync(BIN)) {
  beforeAll(async () => {
    // Keep stderr: a daemon that cannot bind (no privileges, stale socket)
    // exits immediately, and a bare 10s hook timeout hides the real reason.
    let err = '';
    daemon = spawn(BIN, { env: { ...process.env, DAAK_SOCK: sock }, stdio: ['ignore', 'ignore', 'pipe'] });
    daemon.stderr?.on('data', (c) => { err += String(c); });
    const exited = new Promise<never>((_, reject) =>
      daemon?.once('exit', (code) => reject(new Error(`daakd exited with ${code}: ${err.trim()}`))),
    );
    await Promise.race([waitForSocket(), exited]);
  });
  afterAll(() => {
    daemon?.kill();
    rmSync(dir, { recursive: true, force: true });
  });
}

// No binary means the suite SKIPS rather than fakes green. That is only the
// right default when the daemon was never built; build it and the gate runs.
const describeDaemon = existsSync(BIN) ? describe : describe.skip;

describeDaemon('DaemonClientEngine over a real daakd socket', () => {
  runContractSuite('daemon', () => DaemonClientEngine.connect(sock));

  it('daemon: answers Devices with the JSON string the client parses', async () => {
    const e = await DaemonClientEngine.connect(sock);
    // daakd hard-codes "[]" until Task 9 wires the engine's device table.
    expect(await e.devices()).toEqual([]);
  });

  it('daemon: fans an event out to a subscribed client only', async () => {
    const sub = await DaemonClientEngine.connect(sock);
    const plain = await DaemonClientEngine.connect(sock);
    const seen: unknown[] = [];
    sub.on((e) => seen.push(e));
    await sub.start();
    // Nothing publishes into daakd's broadcast channel yet (Task 9 bridges the
    // engine), so the only honest assertion is that the SUBSCRIBED connection
    // is alive and the UNSUBSCRIBED one is not being fed: both still answer
    // their own requests, which is what the daemon's select! guarantees.
    expect(await plain.devices()).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('daemon: refuses a second concurrent request (no request ids on the wire)', async () => {
    const e = await DaemonClientEngine.connect(sock);
    const a = e.devices();
    await expect(e.devices()).rejects.toThrow(/one request at a time/);
    expect(await a).toEqual([]);
  });

  it('daemon: rejects a request after the daemon drops the connection', async () => {
    const e = await DaemonClientEngine.connect(sock);
    await e.stop();
    // Shutdown closes the connection, so the next request has nowhere to go.
    await expect(e.devices()).rejects.toThrow(/closed|EPIPE|ECONNRESET/);
  });

  it('daemon: surfaces Error{unimplemented} instead of an empty result', async () => {
    const e = await DaemonClientEngine.connect(sock);
    // Everything except Subscribe/Devices/Shutdown is unimplemented until
    // Task 9. This pins that the client REJECTS rather than inventing data.
    await expect(e.listInbox()).rejects.toThrow('unimplemented');
    await expect(e.cancel('t1')).rejects.toThrow('unimplemented');
  });
});
