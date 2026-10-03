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

/// A caller-supplied address wins, and the UI is TOLD. Three facts in one test
/// because they are one behaviour:
///
/// 1. the map really does take the caller's address (caller-wins, REQ 3);
/// 2. the DISCOVERED name is kept -- the caller has no better name to offer
///    (daak-cli passes the hex device id as the name), so adopting it would
///    rename a peer the user can already see;
/// 3. a DeviceFound carrying the NEW address is emitted, because the address an
///    earlier event named is no longer the address to dial.
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
    assert!(
        seeded.is_empty(),
        "an insert is not a change; discovery already announced this peer. got {seeded:?}"
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
        re.len(),
        1,
        "re-addressing an already-found device MUST emit an event, or the UI \
         keeps the address the first DeviceFound named. got {re:?}"
    );
    assert_eq!(re[0].device_id, peer);
    assert_eq!(
        re[0].addr, second,
        "and the event must carry the NEW address, not the old one"
    );
    assert_eq!(
        re[0].name, "discovered name",
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
    assert!(
        got.is_empty(),
        "neither call changed the address, so neither may emit; got {got:?}"
    );
}
