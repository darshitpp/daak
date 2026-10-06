// R42d. A pairing address is BETTER evidence than a discovery address.
//
// `commit_pairing` used `or_insert_with`, so a device that an mDNS announce
// had already placed in the map kept its OLD address and a send right after a
// successful pairing still went to the stale peer. A pairing connection is a
// completed handshake on a socket that just worked. An announce is a UDP
// datagram that may be minutes old and may name an address the peer has since
// left. The proven value must replace the announced one, exactly as
// `note_peer` already does for the CLI's one-shot path.
//
// Binds sockets, so it needs an unsandboxed run.

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::engine::{Engine, EngineConfig};
use daak_core::pairing::PairMode;
use daak_core::store::Db;
use std::net::SocketAddr;
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
async fn a_pairing_replaces_a_stale_discovered_address() {
    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    let a = engine("joiner", d1.path().to_path_buf()).await;
    let b = engine("host", d2.path().to_path_buf()).await;

    // An mDNS announce arrived earlier and named a peer at 192.0.2.1:9, a
    // TEST-NET address that nothing is listening on.
    let stale: SocketAddr = "192.0.2.1:9".parse().unwrap();
    let b_id = b.pairing_bundle().await.identity.device_id;
    a.note_peer(b_id, "stale-announce", stale).await;

    b.offer_inbound_pairing(PairMode::Qr).await.unwrap();
    let host = tokio::spawn({
        let b = b.clone();
        async move { b.accept_pairing_once().await.unwrap() }
    });
    a.pair_with(b.local_addr(), b.pairing_bundle().await)
        .await
        .unwrap();
    host.await.unwrap();

    let addr = a
        .devices()
        .await
        .into_iter()
        .find(|d| d.device_id == b_id)
        .expect("a paired peer must be in the device map")
        .addr;
    assert_eq!(
        addr,
        b.local_addr(),
        "a handshake that just completed must win over an older mDNS announce"
    );
}
