// The engine deletes the staged copy of a send when the peer has received it.
// A send that is not delivered keeps its staged copy for the next try.
//
// The first test binds loopback sockets. Under a sandbox that denies
// socket(2) it fails with EPERM. That is the sandbox, not a defect.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::engine::{Engine, EngineConfig, EngineEvent};
use daak_core::manifest::{DeviceRef, Item, Manifest, PayloadKind, CHUNK_SIZE_DEFAULT};
use daak_core::pairing::PairMode;
use daak_core::store::pairings::Pairing;
use daak_core::store::Db;
use tempfile::TempDir;

async fn engine_with(name: &str, out: PathBuf, db: Arc<Db>) -> Engine {
    std::env::set_var("DAAK_MDNS_OFF_LAN", "1");
    let store = Arc::new(MemorySecretStore::default());
    let identity = import_from_store(store.as_ref()).unwrap();
    Engine::start(EngineConfig {
        display_name: name.into(),
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        out_dir: out,
        identity,
        db,
    })
    .await
    .unwrap()
}

fn new_db() -> Arc<Db> {
    let db = Arc::new(Db::open_in_memory().unwrap());
    db.migrate().unwrap();
    db
}

fn file_manifest(sender: [u8; 16], src: &Path) -> Manifest {
    let item = Item::from_file(0, src, CHUNK_SIZE_DEFAULT).unwrap();
    Manifest::new(
        PayloadKind::Media,
        DeviceRef {
            device_id: sender,
            name: "a".into(),
        },
        vec![item],
    )
}

fn staged_dir(out: &TempDir, payload_id: &[u8; 16]) -> PathBuf {
    out.path().join("staging").join(hex::encode(payload_id))
}

#[tokio::test]
async fn after_a_delivered_send_the_staged_directory_of_the_payload_is_gone() {
    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    let a = Arc::new(engine_with("a", d1.path().to_path_buf(), new_db()).await);
    let b = Arc::new(engine_with("b", d2.path().to_path_buf(), new_db()).await);
    let b_addr = b.local_addr();
    let b_bundle = b.pairing_bundle().await;
    let b_id = b_bundle.identity.device_id;
    b.offer_pairing(a.pairing_bundle().await, PairMode::Qr, None)
        .await
        .unwrap();
    let b2 = b.clone();
    let accepted = tokio::spawn(async move { b2.accept_pairing_once().await });
    a.pair_with(b_addr, b_bundle).await.unwrap();
    accepted.await.unwrap().unwrap();
    a.note_peer(b_id, "b", b_addr).await;

    let src_dir = tempfile::tempdir().unwrap();
    let src = src_dir.path().join("a.bin");
    std::fs::write(&src, b"payload bytes").unwrap();
    let manifest = file_manifest(a.identity().device_id(), &src);
    let payload_id = manifest.payload_id;
    let mut rx = a.events();
    a.enqueue_outbox_send(b_id, manifest, vec![src.clone()])
        .await
        .unwrap();
    assert!(
        staged_dir(&d1, &payload_id).is_dir(),
        "the send must stage a copy first"
    );

    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if let EngineEvent::TransferDone { transfer_id } = rx.recv().await.unwrap() {
                if transfer_id == payload_id {
                    return;
                }
            }
        }
    })
    .await
    .expect("no TransferDone event");

    // The cleanup runs in the same task, after the row is done. It can run
    // just after the event, so wait for it for a short time.
    let dir = staged_dir(&d1, &payload_id);
    for _ in 0..50 {
        if !dir.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(!dir.exists(), "the staged directory must be gone");
    assert!(src.exists(), "the user file must stay");
    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_send_that_is_not_delivered_keeps_its_staged_directory() {
    const PEER: [u8; 16] = [5u8; 16];
    let db = new_db();
    db.upsert_pairing(&Pairing {
        peer_device_id: PEER,
        state: "trusted".into(),
        paired_at: 0,
        verify_key: [1u8; 32],
        static_dh_pub: [2u8; 32],
        label: None,
    })
    .unwrap();
    let out = tempfile::tempdir().unwrap();
    let a = engine_with("a", out.path().to_path_buf(), db).await;

    let src_dir = tempfile::tempdir().unwrap();
    let src = src_dir.path().join("a.bin");
    std::fs::write(&src, b"payload bytes").unwrap();
    let manifest = file_manifest(a.identity().device_id(), &src);
    let payload_id = manifest.payload_id;
    let mut rx = a.events();
    a.enqueue_outbox_send(PEER, manifest, vec![src])
        .await
        .unwrap();

    // The peer is not known, so the first try fails. Wait for that try.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(
        staged_dir(&out, &payload_id).is_dir(),
        "the staged directory must stay after a failed try"
    );
    while let Ok(ev) = rx.try_recv() {
        assert!(
            !matches!(ev, EngineEvent::TransferDone { .. }),
            "the send must not be done"
        );
    }
    a.shutdown().await.unwrap();
}
