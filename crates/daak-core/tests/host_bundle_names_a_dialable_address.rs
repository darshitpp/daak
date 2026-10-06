// R42d. The QR the apps show must carry a LAN address.
//
// mDNS does not cross every supported network. Measured on the Android
// emulator: it saw zero peers while unicast to the host worked, so the joiner
// had no address to dial and every send after pairing failed. The host bundle
// is the one place the joiner can learn that address.
//
// It cannot come from `local_addr()`: every shipped engine binds the WILDCARD,
// so that is `[::]:port` and names no host. It must come from the host's
// interface list, ranked by the same `pick_addr` the mDNS record uses, so a
// loopback or a scope-less link-local IPv6 never reaches a peer.
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
            listen_addr: "0.0.0.0:0".parse().unwrap(),
            out_dir: out,
            identity,
            db,
        })
        .await
        .unwrap(),
    )
}

#[tokio::test]
async fn the_qr_address_a_joiner_reads_is_an_address_a_peer_can_dial() {
    let d = tempfile::tempdir().unwrap();
    let host = engine("host", d.path().to_path_buf()).await;

    // This is what the FFI publishes in the bundle's `addr` key, and it is the
    // only value the joiner has on a network mDNS does not cross.
    let addr = daak_core::discovery::host_lan_addr(host.local_addr().port())
        .expect("a host on a LAN owns a routable interface address");

    assert_eq!(
        addr.port(),
        host.local_addr().port(),
        "the address must carry the port the host actually listens on"
    );
    assert!(!addr.ip().is_unspecified(), "the wildcard names no host");
    assert!(
        !addr.ip().is_loopback(),
        "a loopback dials the joiner itself"
    );

    // The dial must actually work. This is the whole claim: the joiner reaches
    // the host by this address with no mDNS announce anywhere in the path.
    daak_core::net::tcp::dial(addr).await.unwrap_or_else(|e| {
        panic!("a joiner must be able to dial the published address {addr}: {e}")
    });
}
