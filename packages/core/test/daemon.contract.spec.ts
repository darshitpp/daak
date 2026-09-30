// The shared contract suite against the REAL daakd binary over a real Unix
// socket. R5: the binary is PREBUILT by the controller (cargo build -p daakd)
// and its path arrives in DAAKD_BIN, so vitest never races cargo's build lock.
//
// This file needs two things the sandbox denies: a spawned process and a bound
// Unix socket. Run it escalated:
//   DAAKD_BIN=../../target/debug/daakd pnpm --filter @daak/core test
// Without DAAKD_BIN the suite is skipped rather than faked green -- see the
// note in the ledger about which assertions are deferred to Task 9.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
let dir: string;
let sock: string;
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
  // B4: a SHARED daemon is no longer honest. Once Shutdown really stops the
  // engine (it used to leave a dead one in the slot), the contract suite's
  // `stop()` test would leave every LATER test -- including the central
  // obligation -- running against a stopped engine, and the central test was
  // silently passing for that reason. Each test gets its own daemon, its own
  // temp data dir and its own socket.
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'daakd-contract-'));
    sock = join(dir, 'daakd.sock');
    // Keep stderr: a daemon that cannot bind (no privileges, stale socket)
    // exits immediately, and a bare 10s hook timeout hides the real reason.
    let err = '';
    // DAAK_TEST_FILE_STORE keeps the spawned debug daakd on the 0600 file store
    // instead of the login Keychain, which blocks on a password prompt a
    // rebuilt binary cannot inherit trust for. main.rs honours it only in debug
    // builds. See crates/daakd/src/main.rs.
    daemon = spawn(BIN, {
      env: { ...process.env, DAAK_SOCK: sock, DAAK_TEST_FILE_STORE: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    daemon.stderr?.on('data', (c) => { err += String(c); });
    const exited = new Promise<never>((_, reject) =>
      daemon?.once('exit', (code) => reject(new Error(`daakd exited with ${code}: ${err.trim()}`))),
    );
    await Promise.race([waitForSocket(), exited]);
  });
  afterEach(() => {
    daemon?.kill();
    daemon = undefined;
    rmSync(dir, { recursive: true, force: true });
  });
}

// No binary means the suite SKIPS rather than fakes green. That is only the
// right default when the daemon was never built; build it and the gate runs.
const describeDaemon = existsSync(BIN) ? describe : describe.skip;

describeDaemon('DaemonClientEngine over a real daakd socket', () => {
  runContractSuite('daemon', () => DaemonClientEngine.connect(sock!));

  it('daemon: answers Devices with the JSON string the client parses', async () => {
    const e = await DaemonClientEngine.connect(sock);
    await e.start();
    // The engine's real device table. A lone daemon on the LAN sees no peers,
    // so the honest answer is an empty array, and the shape is the client's
    // DeviceInfo[].
    expect(await e.devices()).toEqual([]);
  });

  it('daemon: fans an event out to a subscribed client only', async () => {
    const sub = await DaemonClientEngine.connect(sock);
    const plain = await DaemonClientEngine.connect(sock);
    const seen: unknown[] = [];
    sub.on((e) => seen.push(e));
    await sub.start();
    // A real engine event is only produced by real LAN traffic, which a
    // one-daemon test cannot create, so the fan-out itself is proven by the
    // injected-sender test in crates/daakd. What is provable here is that both
    // connections still answer their own requests after subscribing.
    await plain.start();
    expect(seen).toEqual([]);
  });

  it('daemon: refuses a second concurrent request (no request ids on the wire)', async () => {
    const e = await DaemonClientEngine.connect(sock);
    // A fresh daemon has no engine until it is started; this test is about
    // request serialization, not the pre-start guard (crates/daakd covers
    // that), so start it first.
    await e.start();
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

  // THE central obligation of Phase 4: a share to a peer that is not on the
  // LAN is QUEUED (Engine::enqueue_outbox_send), not refused the way the
  // blocking send_secure would refuse it, and the queued row is what the UI's
  // next listTransfers() sees.
  //
  // Precondition, asserted honestly: beforeEach gave this test a FRESH daemon
  // that has never received a Start, and this test issues its own start(), so
  // the engine under test is a LIVE one. (Before the per-test daemon this ran
  // against an engine a previous test's stop() had already shut down.)
  it('daemon: queues a share to an offline peer and lists the row', async () => {
    const e = await DaemonClientEngine.connect(sock);
    await e.start();
    // 'ab'.repeat(16) is 32 hex chars = 16 bytes, the same id shape as every
    // other id in the API, and this peer is certainly not on the LAN.
    const peer = 'ab'.repeat(16);
    const queued = await e.send({ peerDeviceId: peer, text: 'offline' });
    expect(queued.queued).toBe(true);
    expect(queued.transferId).toMatch(/^[0-9a-f]{32}$/);

    const rows = await e.listTransfers({ peerDeviceId: peer });
    expect(rows.some((r) => r.transferId === queued.transferId)).toBe(true);
    const row = rows.find((r) => r.transferId === queued.transferId)!;
    expect(row.peerDeviceId).toBe(peer);
    expect(row.direction).toBe('out');

    // The row is cancelable by its payload id, and cancelling it moves the
    // `transfers` row to canceled (F4: before the enqueue-time insert this
    // updated zero rows and nothing recorded the cancellation).
    await e.cancel(queued.transferId);
    const canceled = await e.listTransfers({ peerDeviceId: peer });
    expect(canceled.find((r) => r.transferId === queued.transferId)!.state).toBe('canceled');

    // A second cancel of an ALREADY-CANCELED row is Ok -- the outbox UPDATE is
    // guarded on state IN ('pending','sending') and matches nothing -- and the
    // row must STAY canceled rather than being relabelled.
    await e.cancel(queued.transferId);
    const after = await e.listTransfers({ peerDeviceId: peer });
    expect(after.find((r) => r.transferId === queued.transferId)!.state).toBe('canceled');
    // A malformed id, and a well-formed id with no row, are both refused.
    await expect(e.cancel('not-hex')).rejects.toThrow(/hex/);
    await expect(e.cancel('00'.repeat(16))).rejects.toThrow();
  });

});
