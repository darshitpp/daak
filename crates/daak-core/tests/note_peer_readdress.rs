// B-3. `note_peer` re-addresses an entry that is already on the map, so the
// address a UI holds can change WITHOUT any event saying so -- the discovery
// path emits DeviceFound only on first insert, and a re-address leaves the
// device "found" forever, so nothing else fires either. The UI then shows (and
// dials) the old address until the peer's next announce, which is the exact
// failure Task 12b set out to remove.
//
// These bind loopback sockets. Under a sandbox that denies socket(2) they
// fail with EPERM, which is the sandbox and not a defect.
use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::engine::{DeviceInfo, Engine, EngineConfig, EngineEvent};
use daak_core::store::Db;

async fn engine(name: &str, out: std::path::PathBuf) -> Engine {
    let store = MemorySecretStore::default();
    let identity = import_from_store(&store).unwrap();
    let db = Db::open_in_memory().unwrap();
    db.migrate().unwrap();
    Engine::start(EngineConfig {
        display_name: name.into(),
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        out_dir: out,
        identity,
        db: db.into(),
    })
    .await
    .unwrap()
}

/// Every DeviceFound left on `rx` after waiting out `window`. The
/// subscription is made ONCE by the caller and passed in, because that is how a
/// UI is wired: one `events()` subscription held for its lifetime. A helper
/// that subscribed on each call would miss an event emitted before it was
/// called, which is exactly the B-3 defect -- the UI subscribed first and
/// still saw nothing.
async fn device_found_within(
    rx: &mut tokio::sync::broadcast::Receiver<EngineEvent>,
    window: std::time::Duration,
) -> Vec<DeviceInfo> {
    let deadline = tokio::time::Instant::now() + window;
    let mut got = Vec::new();
    loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Ok(EngineEvent::DeviceFound(d))) => got.push(d),
            Ok(Ok(_)) => continue,
            Ok(Err(_)) => break,
            Err(_) => break,
        }
    }
    got
}

/// WHY `seeded`/`got` ARE NOT ASSERTED `is_empty` HERE.
///
/// `Engine::start` registers a real mDNS record on UDP 5353 and browses for real
/// peers, so this test binary -- like every other daak-core integration test
/// binary -- can legitimately DISCOVER A SIBLING'S ENGINE, or a running app.
/// That is not a regression: "a browsing peer is inserted into the device map
/// and announced with DeviceFound" is the behaviour under test throughout
/// `discovery`. An `is_empty` on a `DeviceFound` stream is therefore a
/// question about the AMBIENT LAN asked from inside a unit test, and it fails
/// the moment two engines are alive -- the normal state of a multi-test binary.
/// It really has: Task 18's reviewer held four real daakd engines on mDNS and
/// both tests in this file failed, and so did a live macOS app (pid 31405).
///
/// What replaced it is the obligation these tests can actually carry -- SHAPE
/// plus LIVENESS:
///
///   * `devices()` is ANSWERED. This call is holding a tokio mutex, so a dead
///     engine panics here rather than returning, and `self_profile()` proves the
///     very id the answer must not contain.
///   * every reported `DeviceInfo` is one a UI can render and the UI can dial:
///     a non-empty name, and an `ip:port` with a real port to dial.
///
/// The "it is an ARRAY" half of Task 18's helper is NOT re-implemented here,
/// because it CANNOT be at this layer: `devices()` returns `Vec<DeviceInfo>`,
/// a typed vec of a struct whose `device_id` is `[u8; 16]`. There is no
/// untyped payload here to be an object instead of an array -- the obligation
/// is discharged by the TYPE, and a runtime "is 16 bytes" assert on a
/// `[u8; 16]` could never fail, which is precisely the check-that-reads-green
/// shape this task exists to remove. The untyped JSON-string shape is pinned
/// one layer up, in `crates/daakd/tests/engine_dispatch.rs`, where the raw
/// `Devices` payload actually exists.
///
/// The LENGTH is deliberately not asserted. `[]` and `[peer, ...]` are both
/// correct answers for `devices()`, and only the first is what a box with no LAN
/// produces. The point is that the test must not care which.
fn assert_devices_are_addressable(devices: &[DeviceInfo], context: &str) {
    for d in devices {
        assert!(
            !d.name.trim().is_empty(),
            "a device {context} must carry a name the UI can render, got {:?}",
            d.name
        );
        assert!(
            d.addr.port() != 0,
            "a device {context} must carry a dialable ip:port, got {}",
            d.addr
        );
    }
}

/// SELF-EXCLUSION: the engine must never report ITSELF as a peer.
///
/// The discovery task drops an announce whose device id is the engine's own:
///
///     crates/daak-core/src/engine.rs   if device_id == me { continue; }
///
/// Without that line every engine that its own browser can hear sees itself,
/// and the UI's device list offers the user their own machine to send to.
///
/// WHY THERE IS NO SELF-EXCLUSION ASSERTION ANYWHERE ELSE IN THIS FILE.
///
/// There was one, and it was removed in this pass because it COULD NOT FAIL.
/// Every engine here is built by `engine()` above, which binds `127.0.0.1:0`.
/// That flows `advertise_ip(127.0.0.1)` -> `Some(127.0.0.1)` ->
/// `Advertiser::service_info`, which builds the `ServiceInfo` with `addr_auto`
/// OFF and exactly one address (crates/daak-core/src/discovery/mdns.rs:118).
/// So this binary puts NOTHING on the wire that any browser -- including its
/// own -- can be discovered by: the record's only address is the loopback
/// literal, and mdns-sd never offers a loopback-only record on a real
/// interface. Consequently `devices()` here is ALWAYS empty, so "the device
/// list does not contain me" is vacuously true -- on a LAN-less box AND on a
/// busy one. A previous version of this comment claimed the assertion was
/// "load-bearing on a busy [LAN]". That was FALSE and it is what this comment
/// replaces. Task 23's reviewer proved it two ways: deleting the guard in
/// `engine.rs` left this file green, and a probe standing up SIX live
/// advertisers on the LAN recorded 0 announces reaching this file's engines,
/// while a `0.0.0.0`-shaped probe in the same session DID observe its own
/// record. Every shipped entry point binds `0.0.0.0`
/// (crates/daakd/src/lib.rs, crates/daak-cli/src/main.rs), so the shapes that
/// publish at all are exactly the shapes this file does not use.
///
/// END-TO-END SELF-DELIVERY IS THEREFORE NOT OBSERVABLE FROM HERE, and pinning
/// it from here is not possible without changing what this file binds -- which
/// would put ambient LAN state back into a unit test, the exact defect Task 18
/// and Task 23 exist to remove. So nothing in this file samples `me` against a
/// real device list any more. That is a deliberate deletion, not lost
/// coverage.
///
/// WHAT ACTUALLY PINS THE GUARD, and it is deterministic because it needs no
/// socket and no LAN:
///
///   * the negative control below -- a device list carrying the engine's own
///     id is REJECTED, while a list holding only a sibling, and the empty list,
///     are accepted. That is the guard's decision, exercised directly, and it
///     runs even in a sandbox that denies `socket(2)`.
///   * the end-to-end path, in `packages/core/test/daemon.contract.spec.ts`,
///     which drives a real `daakd` -- i.e. `0.0.0.0`, `addr_auto` ON, the
///     production shape where a browser really can deliver a box's own record
///     back to it. There the obligation is met by BOUNDED POLLING on
///     `me in devices`, so self-delivery has time to land and the assertion can
///     go red. That file is the gate; this one is the honest note about why it
///     cannot be.
///
/// Pure and free of an `Engine` on purpose: a check that has to be handed a
/// live engine is a check that cannot be negative-controlled socket-free.
fn assert_devices_exclude(me: [u8; 16], devices: &[DeviceInfo], context: &str) {
    if let Some(me_here) = devices.iter().find(|d| d.device_id == me) {
        panic!(
            "the engine reported ITSELF as a peer {context}: {me_here:?}. The discovery task's self-exclusion guard is the only thing standing between a user and their own machine in the device list. Every device: {devices:?}"
        );
    }
}

/// Negative control for the self-exclusion check above, and the proof that it
/// is not a check that reads green when the property is broken. It needs no
/// Engine and therefore no socket, so it runs even where the rest of this
/// binary cannot.
///
/// A list holding the engine's OWN id must be REJECTED; the same list with
/// some other id must pass, so the control cannot pass by rejecting
/// everything.
#[test]
#[should_panic(expected = "reported ITSELF as a peer")]
fn the_self_exclusion_check_rejects_a_device_list_carrying_its_own_id() {
    let me = [9u8; 16];
    let addr: std::net::SocketAddr = "127.0.0.1:40004".parse().unwrap();
    let myself = DeviceInfo {
        device_id: me,
        name: "me".into(),
        addr,
        paired: true,
    };
    fn sibling(addr: std::net::SocketAddr) -> DeviceInfo {
        DeviceInfo {
            device_id: [1u8; 16],
            name: "sibling".into(),
            addr,
            paired: true,
        }
    }

    // The half that must NOT panic, so the control cannot be passing by
    // rejecting everything.
    assert_devices_exclude(me, &[sibling(addr)], "in the negative control");
    assert_devices_exclude(me, &[], "in the negative control");

    // And the half that must.
    assert_devices_exclude(me, &[sibling(addr), myself], "in the negative control");
}

/// A caller-supplied address wins, and the UI is TOLD. Three facts in one test
/// because they are one behaviour:
///
/// 1. the map really does take the caller's address (caller-wins, REQ 3);
/// 2. the DISCOVERED name is kept -- the caller has no better name to offer
///    (daak-cli passes the hex device id as the name), so adopting it would
///    rename a peer the user can already see;
/// 3. a DeviceFound carrying the NEW address is emitted, because the address an
///    earlier event named is no longer the address to dial.
///
/// Every count below is filtered on `peer.device_id`, never taken over the
/// whole event vector: this subscription is fed by the LIVE discovery feed, so a
/// sibling engine in this binary, another daakd, or a running desktop app all
/// land in it. That is correct behaviour, and a whole-vector length would turn
/// a neighbour into a red test -- or, in the other direction, let a neighbour's
/// event stand in for this peer's. See `assert_devices_are_addressable`.
#[tokio::test]
async fn a_readdressed_peer_announces_its_new_address_to_the_ui() {
    let dir = tempfile::tempdir().unwrap();
    let e = engine("a", dir.path().to_path_buf()).await;
    // One subscription for the whole test, taken before anything is seeded.
    let mut rx = e.events();
    let peer = [7u8; 16];
    let first: std::net::SocketAddr = "127.0.0.1:40001".parse().unwrap();
    let second: std::net::SocketAddr = "127.0.0.1:40002".parse().unwrap();

    // A fresh INSERT stays silent, and that is the pre-existing (correct)
    // behaviour, unchanged here: discovery is what announces a newly seen peer,
    // and note_peer seeding one means the caller was TOLD about it already. The
    // event is for a CHANGE -- an address that did change under a UI that is
    // already holding the old one.
    e.note_peer(peer, "discovered name", first).await;
    let seeded = device_found_within(&mut rx, std::time::Duration::from_millis(250)).await;
    // `seeded` is deliberately NOT asserted empty -- see the note above
    // `assert_devices_are_addressable`. The absence of a DeviceFound for a
    // FIRST INSERT stays covered by the re-address half of this test below,
    // which distinguishes the two cases by address: `seeded` must carry no
    // entry for `peer`, while the re-address must. That is a statement about
    // THIS peer, not about how many peers the LAN has.
    assert_devices_are_addressable(&seeded, "in the DeviceFound stream after an insert");
    assert_eq!(
        seeded.iter().filter(|d| d.device_id == peer).count(),
        0,
        "a FIRST insert is not a discovery and must stay silent -- emitting here \
         would double-report every seeded peer. Filtered on peer.device_id, NOT \
         on the length: a sibling engine on the same LAN puts its own DeviceFound \
         in this very subscription and that is correct behaviour. got {seeded:?}"
    );

    e.note_peer(peer, "a name only the caller has", second)
        .await;
    let re = device_found_within(&mut rx, std::time::Duration::from_millis(250)).await;

    let devices = e.devices().await;
    let d = devices
        .iter()
        .find(|d| d.device_id == peer)
        .expect("still mapped");
    assert_eq!(
        d.addr, second,
        "the caller's address must win -- this is what send_secure dials"
    );
    assert_eq!(
        d.name, "discovered name",
        "the DISCOVERED name is kept: the caller's name is not better, and the \
         UI already shows this peer under the discovered one"
    );
    assert_eq!(
        re.iter().filter(|d| d.device_id == peer).count(),
        1,
        "re-addressing an already-found device MUST emit exactly one event for \
         THAT device, or the UI keeps the address the first DeviceFound named. \
         Counted on peer.device_id, never on the length of `re`: `re` is drained \
         from the shared live discovery feed, so on a busy LAN it also holds a \
         DeviceFound per sibling engine (and per running app) and `re.len() == 1` \
         would then be RED for a sibling, which is this task's whole defect class. \
         The filter is also what keeps it from passing VACUOUSLY: the count is 0 \
         when the re-address is silent, so the obligation is a real one. \
         got {re:?}"
    );
    // The obligation above is on the entry FOR `peer`, so the field asserts below
    // read that entry and not `re[0]` -- index 0 is whichever device the LAN
    // happened to announce first.
    let re_peer = &re[re
        .iter()
        .position(|d| d.device_id == peer)
        .expect("just counted")];
    assert_eq!(
        re_peer.addr, second,
        "and the event must carry the NEW address, not the old one"
    );
    assert_eq!(
        re_peer.name, "discovered name",
        "the event must carry the entry the map holds, or the UI shows a peer \
         under a name it never had"
    );
}

/// Re-seeding the SAME address is not a change, so it must stay silent. A caller
/// that seeds on every send would otherwise flood the event stream (and the UI
/// store) with no-ops that look like rediscovery.
#[tokio::test]
async fn a_reseeded_identical_address_is_silent() {
    let dir = tempfile::tempdir().unwrap();
    let e = engine("a", dir.path().to_path_buf()).await;
    let mut rx = e.events();
    let peer = [8u8; 16];
    let addr: std::net::SocketAddr = "127.0.0.1:40003".parse().unwrap();

    e.note_peer(peer, "b", addr).await;
    e.note_peer(peer, "b", addr).await;
    let got = device_found_within(&mut rx, std::time::Duration::from_millis(250)).await;
    // `got` is deliberately NOT asserted empty: a sibling test's engine or a
    // running app on the same LAN emits its own DeviceFound into this very
    // subscription, and that is correct behaviour, not a failure of this one.
    // See the note above `assert_devices_are_addressable`. What this test DOES
    // own is that re-seeding an UNCHANGED address produces no event for `peer`.
    // Filtered on peer.device_id rather than on the length of `got`, so a
    // sibling's presence can neither redden it nor satisfy it vacuously: the
    // count is 1-when-wrong and 0-when-right, and only this peer's entries can
    // move it.
    assert_devices_are_addressable(&got, "in the DeviceFound stream after a re-seed");
    assert_eq!(
        got.iter().filter(|d| d.device_id == peer).count(),
        0,
        "re-seeding an IDENTICAL address is not a change and must stay silent -- \
         a caller that seeds on every send would flood the event stream with no-ops. \
         Counted on peer.device_id, never on the length of `got`; see above. \
         got {got:?}"
    );
}
