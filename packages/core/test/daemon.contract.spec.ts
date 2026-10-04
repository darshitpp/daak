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

/**
 * WHY THE DEVICES ASSERTIONS BELOW ARE SHAPE-AND-LIVENESS, NOT `toEqual([])`.
 *
 * This suite spawns a REAL daakd, which builds a REAL `daak_core::Engine`,
 * and a real Engine registers an mDNS record on UDP 5353 and browses for real
 * peers. So the daemon under test can legitimately DISCOVER A SIBLING ENGINE --
 * another test in this binary, another binary, or a running desktop app. That
 * is not a regression: "a browsing peer is inserted into the device map" is
 * the product behaviour. `expect(await e.devices()).toEqual([])` therefore
 * asked a question about the AMBIENT LAN from inside a unit test, and it
 * passes only when no other Daak engine happens to be on the LAN -- which
 * makes it a live CI gate that is green by luck. It has failed in the wild.
 *
 * The LENGTH is deliberately not asserted. `[]` and `[peer, ...]` are both
 * correct answers for `Devices`; only the first is what a box with no LAN
 * produces. What is asserted instead is what a client can actually rely on:
 *
 *   * the engine is ALIVE and ANSWERED. `devices()` resolving at all is the
 *     liveness proof: a daemon whose engine slot is empty answers
 *     `Error{"engine not started; send Start first"}`, and a dropped or dead
 *     daemon rejects. Both make this test fail.
 *   * the payload is a JSON ARRAY. NOTE THE LAYER: `devices()` has already
 *     run `parseArray<DeviceInfo>` internally
 *     (`packages/core/src/engine/DaemonClient.ts`), which THROWS on a non-array.
 *     So `await e.devices()` resolving IS the array check. It is re-asserted
 *     explicitly below (`Array.isArray`) so a future refactor that swaps
 *     `parseArray` for a cast cannot silently delete the obligation.
 *   * every element is a DeviceInfo the UI reads BY FIELD NAME --
 *     `deviceId`/`name`/`addr` as strings. An element missing one is a
 *     client-side crash. `online` is deliberately NOT required: daakd's
 *     `Devices` handler does not emit it (it arrives on the `DeviceFound`
 *     event instead), so requiring it would be a false failure.
 *
 * `assertDevicesExcludeSelf` closes the hole Task 18's reviewer found; see
 * its own doc comment.
 */
function assertDevicesAreClientReadable(devices: unknown, context: string): void {
  if (!Array.isArray(devices)) {
    throw new Error(
      `Devices must answer an ARRAY ${context}, since DaemonClient.devices() runs parseArray on it; got ${JSON.stringify(devices)}`,
    );
  }
  for (const d of devices as Record<string, unknown>[]) {
    for (const field of ['deviceId', 'name', 'addr'] as const) {
      if (typeof d[field] !== 'string') {
        throw new Error(
          `every device ${context} must carry ${field} as a string; got ${JSON.stringify(d)}`,
        );
      }
    }
  }
}

/**
 * SELF-EXCLUSION: the daemon must never report ITSELF as a peer.
 *
 * The engine's discovery task drops an announce whose device id is its own:
 *
 *     crates/daak-core/src/engine.rs   if device_id == me { continue; }
 *
 * Without that line every engine on the LAN sees itself and the UI's device
 * list offers the user their own machine to send to. The mDNS browser can
 * deliver a box's OWN record back to it, so the guard is load-bearing.
 *
 * UNTIL NOW NOTHING PINNED IT. `toEqual([])` was the repo's only coverage of
 * it, and only incidentally -- it failed whenever a SIBLING appeared, not
 * whenever self-insertion happened. Task 18's reviewer removed those asserts
 * and grepped the whole repo: no other test names this guard. Without this,
 * an engine that inserted itself into its own device map would pass every
 * test in this file. `selfProfile()` is the right source for the id because
 * it is the SAME `identity.device_id()` the guard compares against, hex
 * encoded -- 32 chars, unconditionally.
 *
 * The predicate is `me in devices` and nothing else, so it never depends on
 * the ambient device count: any number of siblings is legal.
 */
function assertDevicesExcludeSelf(me: string, devices: unknown, context: string): void {
  const self = (devices as Record<string, unknown>[]).find((d) => d.deviceId === me);
  if (self) {
    throw new Error(
      `the daemon reported ITSELF as a peer ${context}: ${JSON.stringify(self)} ` +
        `(this device is ${me}). The engine's self-exclusion guard is the only ` +
        `thing keeping a user's own machine out of their own device list. ` +
        `devices: ${JSON.stringify(devices)}`,
    );
  }
}

/**
 * WHY THE CALLER POLLS INSTEAD OF SAMPLING ONCE.
 *
 * `daakd` binds `0.0.0.0`, so its `ServiceInfo` is built with `addr_auto` ON
 * and its OWN record really is published on a real interface -- which means the
 * browser really can deliver that record back to the same process. That is what
 * the guard exists to swallow. It also means self-delivery is a UDP RACE: at
 * t=0 the browser has usually not parsed the daemon's own announce yet, so
 * sampling `devices()` once immediately after `start()` reads a list that does
 * not yet contain self -- and reads GREEN against a daemon that has the guard
 * deleted.
 *
 * That is not theoretical. Task 23's reviewer built a guard-deleted `daakd`
 * and ran this file against it: 18/18 passed, every run, on first contact.
 * Adding a flat 3s settle before the sample -- no production change, no
 * assertion change -- turned the same binary red. So the immediate sample was a
 * coin flip that read green when it should have read red.
 *
 * The fix is to WAIT for the property rather than sample for it:
 *
 *   * poll `devices()` until either `me` appears -- FAIL IMMEDIATELY, because
 *     the moment self is in the list the guard is already broken -- or the
 *     window elapses, which passes. "Self never appeared within the window" is
 *     precisely and only what the guard promises.
 *   * the window is 3s because that is the settle the reviewer measured as
 *     sufficient: with the guard deleted, six consecutive runs at 3s were all
 *     red, and the failure appeared by ~500ms once the socket buffers and the
 *     mDNS responder were warm. On a cold daemon it needs the full window; that
 *     is the trade, and 3s is the number the evidence supports.
 *   * every poll re-asserts shape as well as self-exclusion, so the poll cannot
 *     quietly stop checking what the single sample used to check.
 *   * `devices()` is a real round trip over the Unix socket on every poll, so
 *     the loop also keeps proving the daemon is ALIVE for the whole window --
 *     a daemon that dies mid-poll rejects and fails the test.
 *
 * Cost of the trade, stated plainly: a healthy daemon pays the window, because
 * "nothing arrived" is exactly the passing case here and there is no earlier
 * signal that proves it. That is the price of converting a race into a gate;
 * the alternative was a check that passes the mutant.
 */
const SELF_EXCLUSION_WINDOW_MS = 3000;
const SELF_EXCLUSION_POLL_MS = 100;

/**
 * Poll `sample` for `windowMs` and fail the moment the daemon reports itself
 * as a peer. Resolves to the last list observed, so the caller can keep
 * asserting on it without a second round trip.
 *
 * `sample` is a parameter rather than a `devices()` call inside the loop, for
 * one reason: it lets the negative control below drive the loop with a scripted
 * sequence and NO daemon. That is the only way to prove the loop really
 * re-samples -- which is the entire claim B2 turns on. A function that took the
 * client directly could only be exercised against a bound socket, so its
 * "keeps polling" behaviour would be unfalsifiable in the suite that most needs
 * it pinned.
 */
async function pollDevicesUntilSelfExcluded(
  sample: () => Promise<unknown[]>,
  me: string,
  context: string,
  windowMs: number = SELF_EXCLUSION_WINDOW_MS,
): Promise<unknown[]> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    const devices = await sample();
    assertDevicesAreClientReadable(devices, context);
    // Count-independent: this is "is ME in the list", never "is the list
    // small". A sibling appearing cannot change the verdict.
    assertDevicesExcludeSelf(me, devices, context);
    if (Date.now() >= deadline) return devices;
    await new Promise((r) => setTimeout(r, SELF_EXCLUSION_POLL_MS));
  }
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
    // Self-exclusion, over the daemon's own report of its identity.
    const me = (await e.selfProfile()).deviceId;
    expect(me).toMatch(/^[0-9a-f]{32}$/);
    // The engine's real device table. Its LENGTH is a property of the LAN, not
    // of the daemon -- see the note above `assertDevicesAreClientReadable` --
    // so what is asserted is that the engine answered, that the answer is the
    // shape the client parses, and that the daemon does not advertise ITSELF.
    //
    // The self-exclusion half is POLLED, not sampled once: `daakd` publishes
    // its own record (0.0.0.0 bind, addr_auto on), so self-delivery is a UDP
    // race and a single immediate sample reads green against a guard-deleted
    // daemon. See `pollDevicesUntilSelfExcluded`. The predicate stays
    // `me in devices`, so a busy LAN changes nothing here.
    const devices = await pollDevicesUntilSelfExcluded(() => e.devices(), me, 'after start');
    expect(Array.isArray(devices)).toBe(true);
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
    // The first request still gets a real answer, not an empty one: its
    // LENGTH is the LAN's business (third instance of the same defect, found
    // here rather than handed to me -- see the report), while the shape and
    // the daemon's liveness are its own.
    const first = await a;
    assertDevicesAreClientReadable(first, 'from the request that was not refused');
    // Same polling discipline as the test above, for the same reason: this
    // sample is otherwise a single point in the self-delivery race and would
    // miss the guard-deleted daemon on a cold start. The refused request above
    // has already proven the serialization behaviour, so nothing here depends
    // on issuing a second concurrent call.
    const me = (await e.selfProfile()).deviceId;
    expect(me).toMatch(/^[0-9a-f]{32}$/);
    await pollDevicesUntilSelfExcluded(() => e.devices(), me, 'after a refused second request');
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

// THE negative controls for both Devices helpers, and the reason the
// assertions above are not checks that read green when the property is
// broken: these prove the helpers actually REJECT what they claim to.
//
// Deliberately a TOP-LEVEL describe, not inside `describeDaemon`: these need
// no daemon, and `describeDaemon` becomes `describe.skip` whenever DAAKD_BIN
// is absent -- which would silently skip the only tests here that can run
// without a socket. A control that can be skipped is not a control.
describe('the Devices assertions are not vacuous', () => {
  it('rejects a non-array payload', () => {
    // A Json response carrying an object instead of an array is exactly what
    // `parseArray` rejects in production, so it must be rejected here too.
    expect(() => assertDevicesAreClientReadable({}, 'in the negative control')).toThrow(
      /must answer an ARRAY/,
    );
    expect(() => assertDevicesAreClientReadable(null, 'in the negative control')).toThrow(
      /must answer an ARRAY/,
    );
  });

  it('rejects an element the UI cannot read', () => {
    // An element missing `addr` is a client-side crash the moment a peer is
    // discovered -- which is exactly when the array stops being empty, so this
    // is the branch the old `toEqual([])` never reached.
    expect(() =>
      assertDevicesAreClientReadable([{ deviceId: '07', name: 'a' }], 'in the negative control'),
    ).toThrow(/must carry addr as a string/);
    expect(() =>
      assertDevicesAreClientReadable([{ deviceId: 7, name: 'a', addr: '10.0.0.2:9000' }], 'in the negative control'),
    ).toThrow(/must carry deviceId as a string/);
  });

  it('accepts every legal answer, INCLUDING one a busy LAN produces', () => {
    // The accept half: without it the rejects above would also pass for a
    // helper that rejects unconditionally.
    expect(() =>
      assertDevicesAreClientReadable([], 'in the negative control'),
    ).not.toThrow();
    expect(() =>
      assertDevicesAreClientReadable(
        [
          { deviceId: '07', name: 'a', addr: '10.0.0.2:9000' },
          { deviceId: '08', name: 'b', addr: '10.0.0.3:9000' },
        ],
        'in the negative control',
      ),
    ).not.toThrow();
    // `online` is OPTIONAL (types.ts declares it `online?`) and daakd's
    // Devices handler does not emit it, so an element without it is legal.
    // Requiring it would fail the suite the moment a peer was discovered.
    expect(() =>
      assertDevicesAreClientReadable(
        [{ deviceId: '07', name: 'a', addr: '10.0.0.2:9000' }],
        'in the negative control',
      ),
    ).not.toThrow();
  });

  it('rejects a device list carrying the engine\'s OWN id', () => {
    const me = '09'.repeat(16);
    const sibling = { deviceId: '08'.repeat(16), name: 'b', addr: '10.0.0.3:9000' };

    // Accept half: siblings are legal, an empty list is legal.
    expect(() =>
      assertDevicesExcludeSelf(me, [sibling], 'in the negative control'),
    ).not.toThrow();
    expect(() => assertDevicesExcludeSelf(me, [], 'in the negative control')).not.toThrow();

    // Reject half: the self-exclusion regression this closes.
    expect(() =>
      assertDevicesExcludeSelf(
        me,
        [sibling, { deviceId: me, name: 'me', addr: '10.0.0.9:9000' }],
        'in the negative control',
      ),
    ).toThrow(/reported ITSELF as a peer/);
    expect(() =>
      assertDevicesExcludeSelf(
        me,
        [{ deviceId: me, name: 'me', addr: '10.0.0.9:9000' }],
        'in the negative control',
      ),
    ).toThrow(/reported ITSELF as a peer/);
  });

  // B2's control, and the only part of the self-exclusion gate that runs
  // socket-free. The bug it pins is TIMING, not the predicate: the pre-fix code
  // sampled devices() once and passed a guard-deleted daakd 18/18. So the
  // property to prove is that the loop RE-SAMPLES until the window closes, and
  // that a self-carrying sample turns it red no matter how late it arrives.
  //
  // Deliberately in this top-level describe, for the same reason the four
  // controls above are: inside describeDaemon it would be skipped whenever
  // DAAKD_BIN is absent, and a control that can be skipped is not a control.
  it('keeps re-sampling until the window, and goes red on a late self', async () => {
    const me = '09'.repeat(16);
    const sibling = { deviceId: '08'.repeat(16), name: 'b', addr: '10.0.0.3:9000' };
    const selfEntry = { deviceId: me, name: 'me', addr: '10.0.0.9:9000' };

    // The accept half, which is also the LOOP half: self never appears, the
    // window closes, and the daemon is re-read throughout. A loop that sampled
    // once would return the same verdict -- so this alone cannot distinguish
    // polling from sampling. The reject half below is what does.
    let reads = 0;
    const quiet = await pollDevicesUntilSelfExcluded(
      async () => {
        reads++;
        return reads === 1 ? [] : [sibling];
      },
      me,
      'in the polling control',
      250,
    );
    expect(reads).toBeGreaterThan(1);
    expect(quiet).toEqual([sibling]);

    // The reject half, and the shape of the mutation that defeated the old
    // single sample: an empty list for the first N reads, then self. A
    // single-sample loop stops at read 1 and returns green; this one must go
    // red. The generous window guarantees the late sample lands before the
    // deadline, so this control cannot flake -- it fails only if the loop
    // stops sampling.
    let late = 0;
    await expect(
      pollDevicesUntilSelfExcluded(
        async () => {
          late++;
          // Late enough to be well past the point an immediate sample would
          // have read, early enough to be inside the window below.
          return late >= 4 ? [sibling, selfEntry] : [];
        },
        me,
        'in the polling control',
        3000,
      ),
    ).rejects.toThrow(/reported ITSELF as a peer/);
    expect(late).toBeGreaterThanOrEqual(4);

    // And the same list with no self in it is accepted at any length, so the
    // reject above cannot be a helper that throws on everything. This is the
    // busy-LAN immunity: adding peers must not change the verdict.
    await expect(
      pollDevicesUntilSelfExcluded(
        async () => [
          sibling,
          { deviceId: '07'.repeat(16), name: 'c', addr: '10.0.0.4:9000' },
          { deviceId: '06'.repeat(16), name: 'd', addr: '10.0.0.5:9000' },
        ],
        me,
        'in the polling control',
        250,
      ),
    ).resolves.toHaveLength(3);
  });
});
