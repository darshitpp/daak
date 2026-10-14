// The code joiner holds the host identity, which carries no name, so it used
// to store the host's hex device id as the pairing label. The host now sends
// its display name after the handshake, and the joiner stores that. The host
// name path must not regress, so this checks both sides.
//
// Binds sockets, so it needs an unsandboxed run.

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::engine::{Engine, EngineConfig};
use daak_core::store::Db;
use std::path::PathBuf;
use std::sync::Arc;

async fn engine(name: &str, out: PathBuf) -> Arc<Engine> {
    let store = Arc::new(MemorySecretStore::default());
    let identity = import_from_store(store.as_ref()).unwrap();
    let db = Arc::new(Db::open_in_memory().unwrap());
    db.migrate().unwrap();
    Arc::new(
        Engine::start(EngineConfig {
            display_name: name.into(),
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            out_dir: out,
            identity,
            db,
        })
        .await
        .unwrap(),
    )
}

#[tokio::test]
async fn the_code_joiner_stores_the_hosts_display_name_not_its_hex_id() {
    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    let joiner = engine("Pixel Test", d1.path().to_path_buf()).await;
    let host = engine("Host Mac", d2.path().to_path_buf()).await;
    let host_id = host.pairing_bundle().await.identity.device_id;
    let joiner_id = joiner.pairing_bundle().await.identity.device_id;

    host.offer_code_pairing("123456".into()).await.unwrap();
    let accept = tokio::spawn({
        let host = host.clone();
        async move { host.accept_pairing_once().await.unwrap() }
    });
    joiner
        .pair_with_code(host.local_addr(), "123456")
        .await
        .unwrap();
    accept.await.unwrap();

    // Read the label back through the public view, not an internal field.
    let host_view = joiner
        .peer_views()
        .await
        .unwrap()
        .into_iter()
        .find(|v| v.device_id == host_id)
        .expect("the host must be listed on the joiner");
    assert_eq!(
        host_view.name, "Host Mac",
        "the joiner must store the host display name, not the hex id"
    );

    // The host name path must not regress.
    let joiner_view = host
        .peer_views()
        .await
        .unwrap()
        .into_iter()
        .find(|v| v.device_id == joiner_id)
        .expect("the joiner must be listed on the host");
    assert_eq!(joiner_view.name, "Pixel Test");
}
