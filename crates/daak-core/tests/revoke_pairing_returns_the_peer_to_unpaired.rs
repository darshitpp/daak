// R42f: EITHER SIDE MAY UNPAIR, AND UNPAIR MUST STICK.
//
// Nothing was able to revoke a pairing. `Engine::revoke_pairing` did not
// exist, so a peer that had ever paired with this device could never be
// removed: it stayed in the device map for the life of the launch, and
// `Engine::start` seeded it again on every later launch because
// `paired_addrs` still returned it. A host also refused to re-pair a peer that
// already had a row, which is what the desktop hit as
// "protocol: noise read: decrypt error".
//
// Binds sockets, so it needs an unsandboxed run.

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::engine::{Engine, EngineConfig};
use daak_core::pairing::PairMode;
use daak_core::store::Db;
use std::path::Path;
use std::sync::Arc;

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

// A peer the engine saw on the network stays listed after the unpair, as a
// nearby device that is NOT paired. The user can pair it again. Before, the
// engine removed it, and a device that never re-announces (mDNS sends nothing
// new for a device that stays on the Wi-Fi) never came back to the list.
// A peer that is only a SAVED address (seeded at start, never seen this launch)
// is dropped: nothing says it is there.
#[tokio::test]
async fn a_revoked_peer_that_was_seen_stays_listed_as_unpaired_and_stays_gone_after_a_restart() {
    let joiner_dir = tempfile::tempdir().unwrap();
    let host_dir = tempfile::tempdir().unwrap();

    let joiner_db = Arc::new(Db::open(&joiner_dir.path().join("daak.db")).unwrap());
    joiner_db.migrate().unwrap();
    let joiner = engine_on(
        joiner_dir.path(),
        "joiner",
        joiner_db,
        Arc::new(MemorySecretStore::default()),
    )
    .await;
    // The host DB is file-backed so the restart below reads the same file.
    let host_db = Arc::new(Db::open(&host_dir.path().join("daak.db")).unwrap());
    host_db.migrate().unwrap();
    let host_store = Arc::new(MemorySecretStore::default());
    let host =
        Arc::new(engine_on(host_dir.path(), "host", host_db.clone(), host_store.clone()).await);

    let joiner_id = joiner.pairing_bundle().await.identity.device_id;
    let host_addr = host.local_addr();
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

    assert!(
        host.devices()
            .await
            .iter()
            .any(|d| d.device_id == joiner_id),
        "the pairing must put the peer in the map to begin with"
    );

    host.revoke_pairing(joiner_id).await.unwrap();

    let after = host
        .devices()
        .await
        .into_iter()
        .find(|d| d.device_id == joiner_id)
        .expect("a peer that was just on the network stays in the list");
    assert!(
        !after.paired,
        "a revoked peer must read as unpaired in the live map"
    );
    let view = host
        .peer_views()
        .await
        .unwrap()
        .into_iter()
        .find(|v| v.device_id == joiner_id)
        .expect("the UI list shows the revoked peer as nearby");
    assert!(!view.paired, "and the UI list says it is not paired");
    assert!(
        view.presence.is_none(),
        "an unpaired device has no presence"
    );
    assert_eq!(
        host_db.get_pairing(&joiner_id).unwrap().unwrap().state,
        "revoked",
        "the row is marked, not deleted, and the state is what records it"
    );
    assert!(
        host_db
            .paired_addrs()
            .unwrap()
            .iter()
            .all(|(id, _, _)| *id != joiner_id),
        "a revoked pairing must not be seeded again"
    );

    host.shutdown().await.unwrap();
    drop(host);

    let restarted = engine_on(host_dir.path(), "host", host_db.clone(), host_store).await;
    assert!(
        !restarted
            .devices()
            .await
            .iter()
            .any(|d| d.device_id == joiner_id),
        "a revoked peer must not come back on the next launch"
    );
}

// A paired peer that is only a saved address (the engine restarted and has not
// seen the peer on the network) is dropped on revoke. Listing it as "nearby"
// would show a device that may not be there.
#[tokio::test]
async fn a_revoked_peer_that_is_only_a_saved_address_leaves_the_list() {
    let joiner_dir = tempfile::tempdir().unwrap();
    let host_dir = tempfile::tempdir().unwrap();
    let joiner_db = Arc::new(Db::open(&joiner_dir.path().join("daak.db")).unwrap());
    joiner_db.migrate().unwrap();
    let joiner = engine_on(
        joiner_dir.path(),
        "joiner",
        joiner_db,
        Arc::new(MemorySecretStore::default()),
    )
    .await;
    let host_db = Arc::new(Db::open(&host_dir.path().join("daak.db")).unwrap());
    host_db.migrate().unwrap();
    let host_store = Arc::new(MemorySecretStore::default());
    let host =
        Arc::new(engine_on(host_dir.path(), "host", host_db.clone(), host_store.clone()).await);

    let joiner_id = joiner.pairing_bundle().await.identity.device_id;
    let host_addr = host.local_addr();
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
    host.shutdown().await.unwrap();
    drop(host);

    // After the restart the peer is in the list only because of its saved
    // address. Nothing has announced it on the network.
    let restarted = engine_on(host_dir.path(), "host", host_db.clone(), host_store).await;
    assert!(
        restarted
            .devices()
            .await
            .iter()
            .any(|d| d.device_id == joiner_id),
        "the restart seeds the paired peer from its saved address"
    );
    restarted.revoke_pairing(joiner_id).await.unwrap();
    assert!(
        !restarted
            .devices()
            .await
            .iter()
            .any(|d| d.device_id == joiner_id),
        "a peer that is only a saved address is dropped on revoke"
    );
}

// An unpaired peer still announces itself over mDNS. A revoked pairing row must
// not make that announce read as "paired": the UI would show a device the user
// just removed, and again on every later launch.
#[tokio::test]
async fn a_revoked_peer_that_announces_again_is_not_marked_paired() {
    let joiner_dir = tempfile::tempdir().unwrap();
    let host_dir = tempfile::tempdir().unwrap();
    let joiner_db = Arc::new(Db::open(&joiner_dir.path().join("daak.db")).unwrap());
    joiner_db.migrate().unwrap();
    let joiner = engine_on(
        joiner_dir.path(),
        "joiner",
        joiner_db,
        Arc::new(MemorySecretStore::default()),
    )
    .await;
    let host_db = Arc::new(Db::open(&host_dir.path().join("daak.db")).unwrap());
    host_db.migrate().unwrap();
    let host = Arc::new(
        engine_on(
            host_dir.path(),
            "host",
            host_db,
            Arc::new(MemorySecretStore::default()),
        )
        .await,
    );

    let joiner_id = joiner.pairing_bundle().await.identity.device_id;
    let host_addr = host.local_addr();
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

    host.revoke_pairing(joiner_id).await.unwrap();
    host.note_peer(joiner_id, "Joiner", "192.168.0.50:4000".parse().unwrap())
        .await;

    let seen = host
        .devices()
        .await
        .into_iter()
        .find(|d| d.device_id == joiner_id)
        .expect("an announce puts the peer back in the map");
    assert!(
        !seen.paired,
        "a revoked peer must read as unpaired when it announces again"
    );
}

// After an unpair, both devices hold a revoked row. The host armed for a new
// QR pairing must still accept the same device. The routing step used to treat
// any existing row as "this is a transfer", so the revoked peer was refused and
// the joiner saw "connection closed during handshake".
#[tokio::test]
async fn a_revoked_peer_can_pair_again_through_the_open_arm() {
    let joiner_dir = tempfile::tempdir().unwrap();
    let host_dir = tempfile::tempdir().unwrap();
    let joiner_db = Arc::new(Db::open(&joiner_dir.path().join("daak.db")).unwrap());
    joiner_db.migrate().unwrap();
    let joiner = engine_on(
        joiner_dir.path(),
        "joiner",
        joiner_db,
        Arc::new(MemorySecretStore::default()),
    )
    .await;
    let host_db = Arc::new(Db::open(&host_dir.path().join("daak.db")).unwrap());
    host_db.migrate().unwrap();
    let host = Arc::new(
        engine_on(
            host_dir.path(),
            "host",
            host_db.clone(),
            Arc::new(MemorySecretStore::default()),
        )
        .await,
    );

    let joiner_id = joiner.pairing_bundle().await.identity.device_id;
    let host_addr = host.local_addr();
    for round in 0..2 {
        host.offer_inbound_pairing(PairMode::Qr).await.unwrap();
        let accepted = tokio::spawn({
            let host = host.clone();
            async move { host.accept_pairing_once().await.unwrap() }
        });
        joiner
            .pair_with(host_addr, host.pairing_bundle().await)
            .await
            .unwrap_or_else(|e| panic!("pairing round {round} failed: {e}"));
        accepted.await.unwrap();
        assert_eq!(
            host_db.get_pairing(&joiner_id).unwrap().unwrap().state,
            "trusted"
        );
        if round == 0 {
            host.revoke_pairing(joiner_id).await.unwrap();
            assert_eq!(
                host_db.get_pairing(&joiner_id).unwrap().unwrap().state,
                "revoked"
            );
        }
    }
}
