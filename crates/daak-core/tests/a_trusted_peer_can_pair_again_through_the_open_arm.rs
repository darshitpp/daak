// A host that shows an open QR must let a device it ALREADY trusts pair again.
//
// Field test 2026-10-11: the Mac still held the iPhone as trusted, the iPhone
// lost its side (a reinstall), and the iPhone's scan of the Mac's QR failed
// with "We couldn't read their code". The open arm routed the connection as a
// transfer, because a trusted device looks like a transfer up to the first
// frame. The joiner now says it is pairing (`Hello::pairing`), and the host
// reads it.
//
// This is safe because a device id is the hash of the identity key: only the
// device that holds the key can claim the id, and the new pairing still waits
// for the numbers to be compared when the gate is on.
//
// Binds sockets, so it needs an unsandboxed run.

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::engine::{Engine, EngineConfig};
use daak_core::pairing::PairMode;
use daak_core::store::Db;
use std::path::Path;
use std::sync::Arc;

async fn engine_on(dir: &Path, name: &str, db: Arc<Db>) -> Engine {
    Engine::start(EngineConfig {
        display_name: name.into(),
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        out_dir: dir.to_path_buf(),
        identity: import_from_store(&MemorySecretStore::default()).unwrap(),
        db,
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn a_trusted_peer_can_pair_again_through_the_open_arm() {
    let joiner_dir = tempfile::tempdir().unwrap();
    let host_dir = tempfile::tempdir().unwrap();
    let joiner_db = Arc::new(Db::open(&joiner_dir.path().join("daak.db")).unwrap());
    joiner_db.migrate().unwrap();
    let joiner = engine_on(joiner_dir.path(), "joiner", joiner_db).await;
    let host_db = Arc::new(Db::open(&host_dir.path().join("daak.db")).unwrap());
    host_db.migrate().unwrap();
    let host = Arc::new(engine_on(host_dir.path(), "host", host_db.clone()).await);

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
        // No unpair between the rounds: the second round pairs a device the
        // host already trusts.
        assert_eq!(
            host_db.get_pairing(&joiner_id).unwrap().unwrap().state,
            "trusted",
            "round {round}"
        );
    }
}
