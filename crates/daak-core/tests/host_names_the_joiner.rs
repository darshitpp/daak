// The QR flow is asymmetric: only the joiner scans, so the host has no bundle
// of the joiner and used to store the joiner's hex device id as its name. The
// joiner now sends its display name after pairing, and the host stores that.
//
// Binds sockets, so it needs an unsandboxed run.

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::engine::{Engine, EngineConfig};
use daak_core::pairing::PairMode;
use daak_core::store::Db;
use std::path::PathBuf;
use std::sync::Arc;

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
async fn the_host_stores_the_joiners_display_name_not_its_hex_id() {
    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    let (joiner, _) = engine("Pixel Test", d1.path().to_path_buf()).await;
    let (host, host_db) = engine("Host Mac", d2.path().to_path_buf()).await;
    let joiner_id = joiner.pairing_bundle().await.identity.device_id;

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

    let label = host_db
        .get_pairing(&joiner_id)
        .unwrap()
        .expect("the host must have stored the pairing")
        .label;
    assert_eq!(label.as_deref(), Some("Pixel Test"));
}
