// F5: the engine records a peer version only for a trusted device. A revoke
// and an unpair remove the version. A `Lost` event keeps it.
//
// Binds sockets, so it needs an unsandboxed run.

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::discovery::mdns::PROTO_VERSION;
use daak_core::engine::{Engine, EngineConfig};
use daak_core::manifest::{from_picked_paths, DeviceRef, CHUNK_SIZE_MIN};
use daak_core::pairing::PairMode;
use daak_core::store::Db;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

async fn engine(name: &str, out: PathBuf) -> (Arc<Engine>, Arc<Db>) {
    std::env::set_var("DAAK_MDNS_OFF_LAN", "1");
    let store = Arc::new(MemorySecretStore::default());
    let identity = import_from_store(store.as_ref()).unwrap();
    let db = Arc::new(Db::open_in_memory().unwrap());
    db.migrate().unwrap();
    let e = Engine::start(EngineConfig {
        display_name: name.into(),
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        out_dir: out,
        identity,
        db: db.clone(),
    })
    .await
    .unwrap();
    (Arc::new(e), db)
}

struct Pair {
    joiner: Arc<Engine>,
    host: Arc<Engine>,
    host_db: Arc<Db>,
    joiner_id: [u8; 16],
    host_id: [u8; 16],
    host_out: tempfile::TempDir,
    _joiner_out: tempfile::TempDir,
}

/// Two engines that are not paired yet.
async fn two() -> Pair {
    let joiner_out = tempfile::tempdir().unwrap();
    let host_out = tempfile::tempdir().unwrap();
    let (joiner, _) = engine("joiner", joiner_out.path().to_path_buf()).await;
    let (host, host_db) = engine("host", host_out.path().to_path_buf()).await;
    let joiner_id = joiner.pairing_bundle().await.identity.device_id;
    let host_id = host.pairing_bundle().await.identity.device_id;
    Pair {
        joiner,
        host,
        host_db,
        joiner_id,
        host_id,
        host_out,
        _joiner_out: joiner_out,
    }
}

/// QR pairing. The joiner dials the host. The gate is off, so both rows are
/// trusted.
async fn pair(p: &Pair) {
    p.host.offer_inbound_pairing(PairMode::Qr).await.unwrap();
    let accept = tokio::spawn({
        let host = p.host.clone();
        async move { host.accept_pairing_once().await.unwrap() }
    });
    p.joiner
        .pair_with(p.host.local_addr(), p.host.pairing_bundle().await)
        .await
        .unwrap();
    accept.await.unwrap();
}

async fn paired() -> Pair {
    let p = two().await;
    pair(&p).await;
    p
}

#[tokio::test]
async fn an_announce_from_an_unknown_id_adds_no_peer_version() {
    let p = paired().await;
    let stranger = [0x5au8; 16];

    p.joiner.note_announce(stranger, PROTO_VERSION);

    assert_eq!(
        p.joiner.peer_version(stranger),
        None,
        "an id with no trusted row must not get a peer version"
    );
    // The trusted peer still gets its version.
    p.joiner.note_announce(p.host_id, PROTO_VERSION);
    assert_eq!(p.joiner.peer_version(p.host_id), Some(PROTO_VERSION));
}

#[tokio::test]
async fn a_revoke_removes_the_peer_version() {
    let p = paired().await;
    p.joiner.note_peer_version(p.host_id, PROTO_VERSION);

    p.joiner.revoke_pairing(p.host_id).await.unwrap();

    assert_eq!(
        p.joiner.peer_version(p.host_id),
        None,
        "a revoke must remove the peer version"
    );
}

#[tokio::test]
async fn an_unpair_from_the_peer_removes_the_peer_version() {
    let p = paired().await;
    p.host.note_peer_version(p.joiner_id, PROTO_VERSION);

    // The joiner unpairs. The host hears the notice and revokes its own row.
    p.joiner.revoke_pairing(p.host_id).await.unwrap();
    let revoked = async {
        loop {
            if p.host_db
                .get_pairing(&p.joiner_id)
                .unwrap()
                .is_some_and(|row| row.state == "revoked")
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(5), revoked)
        .await
        .expect("the host must revoke its row when the peer unpairs");

    assert_eq!(
        p.host.peer_version(p.joiner_id),
        None,
        "an unpair from the peer must remove the peer version"
    );
}

/// Pin: the peer announced before the pairing, so the sender knows no version.
/// The sender does not wait for a resume frame. The receiver sends one, and
/// the sender skips it. The send completes.
#[tokio::test]
async fn the_first_send_right_after_pairing_completes_when_the_receiver_sends_a_resume_frame() {
    let p = two().await;
    // The announce arrives while no pairing row exists.
    p.joiner.note_announce(p.host_id, PROTO_VERSION);
    pair(&p).await;

    let src = tempfile::tempdir().unwrap();
    let root = src.path().join("album");
    std::fs::create_dir_all(&root).unwrap();
    let body: Vec<u8> = (0..(CHUNK_SIZE_MIN as usize * 2 + 5))
        .map(|i| (i % 251) as u8)
        .collect();
    std::fs::write(root.join("a.bin"), &body).unwrap();
    let me = DeviceRef {
        device_id: p.joiner_id,
        name: "joiner".into(),
    };
    let (manifest, sources) = from_picked_paths(me, &[root], CHUNK_SIZE_MIN).unwrap();
    let paths = sources.into_iter().map(Some).collect();

    tokio::time::timeout(
        Duration::from_secs(20),
        p.joiner.send_secure(p.host_id, manifest, paths),
    )
    .await
    .expect("the send hung")
    .expect("the first send after pairing must complete");

    assert_eq!(
        std::fs::read(p.host_out.path().join("album").join("a.bin")).unwrap(),
        body
    );
}

/// Pin: a `Lost` event keeps the peer version. A Wi-Fi flap must not force a
/// full send of a partly received folder.
#[tokio::test]
async fn a_lost_event_keeps_the_peer_version() {
    let p = paired().await;
    p.joiner.note_announce(p.host_id, PROTO_VERSION);

    p.joiner.note_lost(p.host_id).await;

    assert_eq!(p.joiner.peer_version(p.host_id), Some(PROTO_VERSION));
}
