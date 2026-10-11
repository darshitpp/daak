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

    // The peer that unpaired us has just connected, so it is on the network.
    // It may stay in the map as a nearby device, but never as a paired one.
    assert!(
        host.devices()
            .await
            .iter()
            .filter(|d| d.device_id == joiner_id)
            .all(|d| !d.paired),
        "the peer must not read as paired on the notified device"
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

fn notice_key(peer: &[u8; 16]) -> String {
    format!("unpair_notice:{}", hex::encode(peer))
}

#[tokio::test]
async fn an_unpair_for_an_offline_peer_is_delivered_when_it_returns() {
    use daak_core::crypto::secret_store::MemorySecretStore;
    let (d1, d2) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (joiner, joiner_db) = engine("joiner", d1.keep()).await;
    // The host keeps its store and database so it can restart as the same device.
    let host_store = Arc::new(MemorySecretStore::default());
    let host_db = Arc::new(Db::open_in_memory().unwrap());
    host_db.migrate().unwrap();
    let start_host = |dir: PathBuf| {
        let store = host_store.clone();
        let db = host_db.clone();
        async move {
            Arc::new(
                Engine::start(EngineConfig {
                    display_name: "host".into(),
                    listen_addr: "127.0.0.1:0".parse().unwrap(),
                    out_dir: dir,
                    identity: import_from_store(store.as_ref()).unwrap(),
                    db,
                })
                .await
                .unwrap(),
            )
        }
    };
    let host = start_host(d2.keep()).await;
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

    // The host goes offline. The joiner unpairs anyway.
    host.shutdown().await.unwrap();
    drop(host);
    joiner.revoke_pairing(host_id).await.unwrap();
    assert!(
        joiner_db
            .get_setting(&notice_key(&host_id))
            .unwrap()
            .is_some(),
        "an undelivered unpair notice must be kept"
    );
    assert_eq!(
        host_db.get_pairing(&joiner_id).unwrap().unwrap().state,
        "trusted",
        "the offline host has not heard yet"
    );

    // The host returns on a new port and the joiner sees it again.
    let host = start_host(tempfile::tempdir().unwrap().keep()).await;
    joiner.note_peer(host_id, "host", host.local_addr()).await;

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
        .expect("the returning peer must receive the notice");
    // The notice is cleared once it is delivered.
    let cleared = async {
        loop {
            if joiner_db
                .get_setting(&notice_key(&host_id))
                .unwrap()
                .is_none()
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(5), cleared)
        .await
        .expect("a delivered notice must be cleared");
}
