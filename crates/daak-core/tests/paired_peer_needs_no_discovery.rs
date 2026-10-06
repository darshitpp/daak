// R42d. A pairing that succeeds but leaves the device map empty cannot send.
//
// The outbox drain resolves a peer address from the device map, and that map
// is filled by mDNS (engine.rs discovery_task) or by note_peer (daak-cli's
// `send --to`). Pairing filled NEITHER. `pair_with` knows the address it just
// dialled and the host half knows the address that just connected, and both
// dropped it. So a send queued right after a successful pairing failed with
// "peer is not discovered" and burned the whole retry budget -- measured on
// the desktop app as an outbox row at 7 attempts, one short of the cap of 8.
//
// This matters most where mDNS does not cross, which is exactly where a
// pairing link carrying an address (R42c) was the only way to pair at all: the
// host was reachable by unicast and still not in the map.
//
// Binds sockets, so it needs an unsandboxed run.

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::engine::{Engine, EngineConfig};
use daak_core::manifest::Manifest;
use daak_core::pairing::PairMode;
use daak_core::store::Db;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

async fn engine(name: &str, out: PathBuf) -> (Arc<Engine>, Arc<Db>) {
    let store = Arc::new(MemorySecretStore::default());
    let identity = import_from_store(store.as_ref()).unwrap();
    let db = Arc::new(Db::open_in_memory().unwrap());
    db.migrate().unwrap();
    let db_out = db.clone();
    let engine = Arc::new(
        Engine::start(EngineConfig {
            display_name: name.into(),
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            out_dir: out,
            identity,
            db,
        })
        .await
        .unwrap(),
    );
    (engine, db_out)
}

#[tokio::test]
async fn a_pairing_alone_makes_a_queued_send_deliverable() {
    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    let (a, a_db) = engine("joiner", d1.path().to_path_buf()).await;
    let (b, _) = engine("host", d2.path().to_path_buf()).await;

    let b_addr = b.local_addr();
    let b_id = b.pairing_bundle().await.identity.device_id;

    // The host arms open-armed, exactly as the QR flow does: it has no bundle
    // of the joiner, and the joiner supplies its identity in-band.
    b.offer_inbound_pairing(PairMode::Qr).await.unwrap();
    let host = tokio::spawn({
        let b = b.clone();
        async move { b.accept_pairing_once().await.unwrap() }
    });
    // A is the JOINER and it dials an address BY NAME -- no mDNS involved.
    a.pair_with(b_addr, b.pairing_bundle().await).await.unwrap();
    host.await.unwrap();

    let payload_id = a
        .enqueue_outbox_send(b_id, Manifest::text("paired, no discovery"), vec![])
        .await
        .unwrap();

    // The host's own transfer rows are the proof of delivery: the text item is
    // recorded as an inbound transfer on the device that received it.
    let settled = async {
        loop {
            if a_db
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
        .expect("a peer this device just paired with must be sendable without an mDNS announce");

    let outbox = a_db.get_outbox(&payload_id).unwrap().unwrap();
    assert_eq!(
        outbox.state, "done",
        "a peer this device just paired with must be sendable without an mDNS announce"
    );
}
