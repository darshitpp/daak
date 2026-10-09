// R42d. The whole product path over the wire, with no mDNS anywhere.
//
// The reported symptom was "macOS and Android pair but never transfer". Two
// defects sat behind it: pairing left the peer out of the device map the send
// path resolves from, and the host QR named no LAN address at all, because
// every shipped engine binds the wildcard.
//
// This walks the path the apps walk, using the address the QR publishes:
//
//   1. the joiner dials the address OUT OF THE HOST BUNDLE,
//   2. the host accepts the inbound pairing,
//   3. the joiner sends a text item,
//   4. the joiner sends a file,
//   5. the host records BOTH as received transfers.
//
// The host never announces and the joiner never browses, so a pass cannot be a
// discovery pass in disguise.
//
// Binds sockets, so it needs an unsandboxed run.

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::engine::{Engine, EngineConfig};
use daak_core::manifest::{from_picked_paths, DeviceRef, Manifest, CHUNK_SIZE_DEFAULT};
use daak_core::pairing::PairMode;
use daak_core::store::Db;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

async fn engine(name: &str, out: PathBuf) -> (Arc<Engine>, Arc<Db>) {
    // This test starts a real engine on a wildcard bind. Without this setting,
    // the engine announces a fake device to every phone on the LAN.
    std::env::set_var("DAAK_MDNS_OFF_LAN", "1");
    let store = Arc::new(MemorySecretStore::default());
    let identity = import_from_store(store.as_ref()).unwrap();
    let db = Arc::new(Db::open_in_memory().unwrap());
    db.migrate().unwrap();
    let db_out = db.clone();
    let engine = Arc::new(
        Engine::start(EngineConfig {
            display_name: name.into(),
            // The WILDCARD, exactly as daakd, daak-ffi and daak-cli request it.
            listen_addr: "0.0.0.0:0".parse().unwrap(),
            out_dir: out,
            identity,
            db,
        })
        .await
        .unwrap(),
    );
    (engine, db_out)
}

/// Wait until the host has recorded an inbound transfer of the given kind.
async fn host_received(host: &Engine, kind: &str) {
    let mut seen: Vec<(String, String)> = Vec::new();
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            seen = host
                .list_transfers(Some("done"), None)
                .unwrap_or_default()
                .into_iter()
                .filter(|r| r.direction == "in")
                .map(|r| (r.kind.clone(), r.state.clone()))
                .collect();
            if seen.iter().any(|(k, _)| k == kind) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("the host never recorded a done inbound {kind}. it has: {seen:?}"));
}

#[tokio::test]
async fn a_pair_over_the_published_address_delivers_text_and_a_file() {
    let join_dir = tempfile::tempdir().unwrap();
    let recv_dir = tempfile::tempdir().unwrap();
    let payload_dir = tempfile::tempdir().unwrap();
    // The HOST receives, so its out_dir is where the bytes must land.
    let (host, _host_db) = engine("host", recv_dir.path().to_path_buf()).await;
    let (join, join_db) = engine("joiner", join_dir.path().to_path_buf()).await;

    // Step 1. The address the host QR publishes. Nothing else can carry it.
    let host_addr = daak_core::discovery::host_lan_addr(host.local_addr().port())
        .expect("this host owns a LAN interface");
    let host_id = host.pairing_bundle().await.identity.device_id;

    // Step 2.
    host.offer_inbound_pairing(PairMode::Qr).await.unwrap();
    let accepted = tokio::spawn({
        let host = host.clone();
        async move { host.accept_pairing_once().await.unwrap() }
    });
    join.pair_with(host_addr, host.pairing_bundle().await)
        .await
        .unwrap();
    accepted.await.unwrap();

    let (join_name, join_id) = join.self_profile().await;

    // Step 3. Text, through the shape FfiEngine::send_text builds.
    let mut text_manifest = Manifest::text("hello over the lan");
    text_manifest.sender = DeviceRef {
        device_id: join_id,
        name: join_name.clone(),
    };
    let text_id = join
        .enqueue_outbox_send(host_id, text_manifest, vec![])
        .await
        .unwrap();
    host_received(&host, "text").await;

    // Step 4. A file, through the picker FfiEngine::send_files makes.
    let file = payload_dir.path().join("proof.bin");
    let bytes: Vec<u8> = (0..CHUNK_SIZE_DEFAULT as usize + 1)
        .map(|i| (i % 251) as u8)
        .collect();
    std::fs::write(&file, &bytes).unwrap();
    let (manifest, sources) = from_picked_paths(
        DeviceRef {
            device_id: join_id,
            name: join_name.clone(),
        },
        &[file],
        CHUNK_SIZE_DEFAULT,
    )
    .unwrap();
    let file_id = join
        .enqueue_outbox_send(host_id, manifest, sources)
        .await
        .unwrap();

    // Step 5. The SENDER's row reaching done is the proof the receiver
    // verified the bytes, so it is the state worth waiting on.
    for (id, what) in [(text_id, "text"), (file_id, "file")] {
        tokio::time::timeout(Duration::from_secs(60), async {
            loop {
                let row = join_db.get_outbox(&id).unwrap();
                if row.is_some_and(|r| r.state == "done") {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            let row = join_db.get_outbox(&id).unwrap().unwrap();
            panic!("the {what} send never reached done. the row is {row:?}")
        });
    }
    // A binary share is recorded as "media": from_picked_paths picks
    // PayloadKind::Media for anything that is not a single text item, so the
    // host's kind column says "media" for the file, not "file".
    host_received(&host, "media").await;

    // The bytes on disk must be the bytes that were sent.
    let landed = recv_dir.path().join("proof.bin");
    let got = std::fs::read(&landed).unwrap_or_else(|e| panic!("the file never landed: {e}"));
    assert_eq!(
        got, bytes,
        "a delivered stream with the wrong bytes is still a defect"
    );
}
