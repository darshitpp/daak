// R42d: A PAIRED ADDRESS MUST SURVIVE A RESTART.
//
// `commit_pairing` wrote the proven socket address into the in-memory device
// map and nothing else. The `devices.last_seen_addr` column exists and stayed
// NULL for every paired peer. The map starts EMPTY on each launch, so after a
// restart a paired peer had no address at all and every send failed with
// "peer is not discovered" until the next mDNS announce.
//
// This bites hardest where mDNS does not cross a boundary, which is the whole
// reason a pairing link carries an address (R42c). The Android emulator mDNS
// does not cross the emulator NAT, so a restart there made a paired phone
// vanish from the UI.
//
// SQLite is the source of truth (locked rule), so the address belongs in the
// devices row and the engine must seed the map from it at start.
//
// Binds sockets, so it needs an unsandboxed run.

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::engine::{Engine, EngineConfig};
use daak_core::manifest::Manifest;
use daak_core::pairing::PairMode;
use daak_core::store::Db;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

async fn engine_on(dir: &Path, name: &str, db: Arc<Db>, store: Arc<MemorySecretStore>) -> Engine {
    Engine::start(EngineConfig {
        display_name: name.into(),
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        out_dir: dir.to_path_buf(),
        identity: import_from_store(store.as_ref()).unwrap(),
        db,
    })
    .await
    .unwrap()
}

fn in_memory_db() -> Db {
    let db = Db::open_in_memory().unwrap();
    db.migrate().unwrap();
    db
}

/// The headline: pair, restart the sender, send again with no mDNS anywhere.
#[tokio::test]
async fn a_paired_peer_is_sendable_after_the_sender_restarts() {
    let joiner_dir = tempfile::tempdir().unwrap();
    let host_dir = tempfile::tempdir().unwrap();

    let joiner_store = Arc::new(MemorySecretStore::default());
    let joiner_db = Arc::new(Db::open(&joiner_dir.path().join("daak.db")).unwrap());
    joiner_db.migrate().unwrap();
    let joiner = engine_on(
        joiner_dir.path(),
        "joiner",
        joiner_db.clone(),
        joiner_store.clone(),
    )
    .await;

    let host = Arc::new(
        engine_on(
            host_dir.path(),
            "host",
            Arc::new(in_memory_db()),
            Arc::new(MemorySecretStore::default()),
        )
        .await,
    );

    let host_addr = host.local_addr();
    let host_id = host.pairing_bundle().await.identity.device_id;

    host.offer_inbound_pairing(PairMode::Qr).await.unwrap();
    let accepted = tokio::spawn({
        let host = host.clone();
        async move { host.accept_pairing_once().await.unwrap() }
    });
    joiner
        .pair_with(host_addr, host.pairing_bundle().await)
        .await
        .unwrap();
    accepted.await.unwrap();

    // The address the handshake proved must be in the file, not only in RAM.
    let stored = joiner_db.paired_addrs().unwrap();
    assert_eq!(
        stored
            .iter()
            .find(|(id, _, _)| *id == host_id)
            .map(|(_, _, a)| *a)
            .unwrap_or_else(|| panic!(
                "a pairing must record the proven address in the database: {stored:?}"
            )),
        host_addr
    );

    joiner.shutdown().await.unwrap();
    drop(joiner);

    // A second engine on the SAME directory. It shares the identity and the
    // database, so the only thing that can restore the peer is a read from the
    // file. mDNS is not running in this test and never was.
    let restarted = engine_on(
        joiner_dir.path(),
        "daak",
        joiner_db.clone(),
        joiner_store.clone(),
    )
    .await;

    let peers = restarted.devices().await;
    assert!(
        peers
            .iter()
            .any(|d| d.device_id == host_id && d.addr == host_addr),
        "a paired peer must be dialable again after a restart: {peers:?}"
    );

    let payload_id = restarted
        .enqueue_outbox_send(host_id, Manifest::text("after a restart"), vec![])
        .await
        .unwrap();

    let settled = async {
        loop {
            if joiner_db
                .get_outbox(&payload_id)
                .unwrap()
                .is_some_and(|r| r.state == "done")
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(45), settled)
        .await
        .expect("a paired peer must be sendable after a restart with no mDNS");

    assert_eq!(
        joiner_db.get_outbox(&payload_id).unwrap().unwrap().state,
        "done"
    );
}

/// The map entry must carry a NAME too, or the UI shows a hex device id. The
/// name comes from the pairing label, which is the name the peer advertised
/// when the handshake ran. A later `note_peer` rename is discovery-layer state
/// and is not persisted, which is a separate question and not this defect.
#[tokio::test]
async fn a_restored_peer_keeps_a_readable_name() {
    let joiner_dir = tempfile::tempdir().unwrap();
    let host_dir = tempfile::tempdir().unwrap();

    let joiner_store = Arc::new(MemorySecretStore::default());
    let joiner_db = Arc::new(Db::open(&joiner_dir.path().join("daak.db")).unwrap());
    joiner_db.migrate().unwrap();
    let joiner = engine_on(
        joiner_dir.path(),
        "joiner",
        joiner_db.clone(),
        joiner_store.clone(),
    )
    .await;

    let host = Arc::new(
        engine_on(
            host_dir.path(),
            "host",
            Arc::new(in_memory_db()),
            Arc::new(MemorySecretStore::default()),
        )
        .await,
    );

    let host_id = host.pairing_bundle().await.identity.device_id;
    host.offer_inbound_pairing(PairMode::Qr).await.unwrap();
    let accepted = tokio::spawn({
        let host = host.clone();
        async move { host.accept_pairing_once().await.unwrap() }
    });
    joiner
        .pair_with(host.local_addr(), host.pairing_bundle().await)
        .await
        .unwrap();
    accepted.await.unwrap();

    joiner.shutdown().await.unwrap();
    drop(joiner);

    let restarted = engine_on(
        joiner_dir.path(),
        "daak",
        joiner_db.clone(),
        joiner_store.clone(),
    )
    .await;
    let peers = restarted.devices().await;
    let peer = peers
        .iter()
        .find(|d| d.device_id == host_id)
        .expect("the paired peer must be restored from the database");
    assert_eq!(
        peer.name, "host",
        "a restored peer must carry the name it advertised at pairing time"
    );
}
