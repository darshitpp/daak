// Unpairing is no longer silent. A tells B when A unpairs, and B forgets A too.
// See docs/superpowers/specs/2026-10-09-unpair-notification.md.
//
// Binds sockets, so it needs an unsandboxed run.

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::engine::{Engine, EngineConfig, EngineEvent};
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
    let e = Arc::new(
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
    (e, db_out)
}

/// The joiner dials the host, so the joiner holds the host's loopback address.
async fn paired() -> (
    Arc<Engine>,
    Arc<Db>,
    Arc<Engine>,
    Arc<Db>,
    [u8; 16],
    [u8; 16],
) {
    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    let (joiner, joiner_db) = engine("joiner", d1.keep()).await;
    let (host, host_db) = engine("host", d2.keep()).await;
    let joiner_id = joiner.pairing_bundle().await.identity.device_id;
    let host_id = host.pairing_bundle().await.identity.device_id;
    host.offer_inbound_pairing(PairMode::Qr).await.unwrap();
    let accept = tokio::spawn({
        let host = host.clone();
        async move { host.accept_pairing_once().await.unwrap() }
    });
    joiner
        .pair_with(host.local_addr(), host.pairing_bundle().await)
        .await
        .unwrap();
    accept.await.unwrap();
    (joiner, joiner_db, host, host_db, joiner_id, host_id)
}

#[tokio::test]
async fn unpairing_on_one_device_unpairs_the_other() {
    let (joiner, _jdb, host, host_db, joiner_id, host_id) = paired().await;
    let mut host_events = host.events();

    joiner.revoke_pairing(host_id).await.unwrap();

    let revoked = async {
        loop {
            if host_db
                .get_pairing(&joiner_id)
                .unwrap()
                .is_some_and(|p| p.state == "revoked")
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(5), revoked)
        .await
        .expect("the peer must revoke its own pairing when told");

    assert!(
        !host
            .devices()
            .await
            .iter()
            .any(|d| d.device_id == joiner_id),
        "the peer must leave the notified device's map"
    );
    let mut saw_event = false;
    while let Ok(ev) = host_events.try_recv() {
        if matches!(ev, EngineEvent::PairingRevoked(id) if id == joiner_id) {
            saw_event = true;
        }
    }
    assert!(saw_event, "the notified device must emit PairingRevoked");
}

#[tokio::test]
async fn unpairing_an_unreachable_peer_still_completes_locally() {
    let (joiner, joiner_db, host, _hdb, _joiner_id, host_id) = paired().await;
    host.shutdown().await.unwrap();
    drop(host);

    tokio::time::timeout(Duration::from_secs(10), joiner.revoke_pairing(host_id))
        .await
        .expect("an unreachable peer must not stall the revoke")
        .unwrap();

    assert_eq!(
        joiner_db.get_pairing(&host_id).unwrap().unwrap().state,
        "revoked"
    );
}
