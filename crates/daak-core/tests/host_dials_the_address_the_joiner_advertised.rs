// R42e: THE HOST MUST DIAL THE ADDRESS THE JOINER ADVERTISED, NOT THE ONE THE
// PAIRING SOCKET CAME FROM.
//
// A joiner dials the host from an ephemeral source port. When the handshake
// ends that socket closes, so the host's view of "where this connection came
// from" is a port nothing listens on. `commit_pairing` stored that port as the
// peer's address, so every host-to-joiner send failed on connection refused
// while the joiner (which stored the host's advertised address) worked.
//
// Measured on the desktop: the Mac stored `192.168.0.226:50956`, the iPhone
// listened on `50955`, and the transfer sat in backoff forever.
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

#[tokio::test]
async fn the_host_stores_the_joiners_dialable_address() {
    let joiner_dir = tempfile::tempdir().unwrap();
    let host_dir = tempfile::tempdir().unwrap();

    let joiner_store = Arc::new(MemorySecretStore::default());
    let joiner_db = Arc::new(Db::open(&joiner_dir.path().join("daak.db")).unwrap());
    joiner_db.migrate().unwrap();
    let joiner = engine_on(joiner_dir.path(), "joiner", joiner_db, joiner_store).await;

    let host_db_path = host_dir.path().join("daak.db");
    let host_db = Arc::new(Db::open(&host_db_path).unwrap());
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
    // What the joiner advertises: the LAN address that carries its listen port.
    let advertised = match daak_core::discovery::host_lan_addr(joiner.local_addr().port()) {
        Some(a) => a,
        // No LAN interface: the frame is not sent and the host keeps the old
        // behaviour, which is not what this test is about.
        None => return,
    };

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

    let stored = host_db.paired_addrs().unwrap();
    let got = stored
        .iter()
        .find(|(id, _, _)| *id == joiner_id)
        .map(|(_, _, a)| *a);
    assert_eq!(
        got,
        Some(advertised),
        "the host must store the joiner's advertised address, not the pairing \
         socket's source port: {stored:?}"
    );
    // The bug this pins: the stored port was the joiner's OUTBOUND source port,
    // so it never matched the port the joiner listens on.
    assert_eq!(
        got.map(|a| a.port()),
        Some(advertised.port()),
        "the stored port must be the joiner's listen port"
    );
}
