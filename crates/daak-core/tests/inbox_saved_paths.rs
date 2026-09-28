// B3: `inbox_history.saved_paths` must be the JSON array of the destinations
// the receiver ACTUALLY created, not the hardcoded "[]" placeholder. These
// tests drive two real Engines over the real transport and then read the
// PERSISTED row, so they cannot pass on a hand-built event.
//
// These bind loopback sockets. Under a sandbox that denies socket(2) they fail
// with EPERM, which is the sandbox and not a defect.
use std::sync::Arc;

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::engine::{Engine, EngineConfig, EngineEvent};
use daak_core::manifest::{DeviceRef, Item, Manifest, PayloadKind, CHUNK_SIZE_DEFAULT};
use daak_core::pairing::PairMode;
use daak_core::store::Db;
use tempfile::TempDir;

async fn engine(name: &str, out: std::path::PathBuf) -> (Engine, Arc<Db>) {
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
    (e, db)
}

/// Two paired engines. A sends to B over the real transport. The tempdirs are
/// returned: a TempDir dropped while the engines are still running deletes the
/// out dir out from under them.
async fn paired() -> (Arc<Engine>, Arc<Engine>, TempDir, TempDir) {
    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    let (a, _) = engine("a", d1.path().to_path_buf()).await;
    let (b, _) = engine("b", d2.path().to_path_buf()).await;
    let (a, b) = (Arc::new(a), Arc::new(b));
    let b_addr = b.local_addr();
    let b_bundle = b.pairing_bundle().await;
    let b_id = b_bundle.identity.device_id;

    b.offer_pairing(a.pairing_bundle().await, PairMode::Qr, None)
        .await
        .unwrap();
    let b_for_accept = b.clone();
    let accepted = tokio::spawn(async move { b_for_accept.accept_pairing_once().await });
    a.pair_with(b_addr, b_bundle).await.unwrap();
    accepted.await.unwrap().unwrap();
    // send_secure resolves the peer's address from the device map; no
    // discovery runs in these tests, so seed it.
    a.note_peer(b_id, "b", b_addr).await;
    (a, b, d1, d2)
}

/// Wait for the receiver's persisted inbox row for `payload_id`.
async fn inbox_row(b: &Engine, payload_id: [u8; 16]) -> daak_core::store::inbox::InboxRow {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if let Some(row) = b
            .list_inbox()
            .unwrap()
            .into_iter()
            .find(|r| r.id == payload_id)
        {
            return row;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for the inbox row of {}",
            hex::encode(payload_id)
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

/// The real defect: a received FILE share must record the paths on disk.
#[tokio::test]
async fn a_received_file_records_the_destinations_it_actually_wrote() {
    let (a, b, a_dir, b_dir) = paired().await;
    let src = a_dir.path().join("payload.bin");
    std::fs::write(&src, vec![7u8; 40_000]).unwrap();
    let item = Item::from_file(0, &src, CHUNK_SIZE_DEFAULT).unwrap();
    let manifest = Manifest::new(
        PayloadKind::Media,
        DeviceRef {
            device_id: a.identity().device_id(),
            name: "a".into(),
        },
        vec![item],
    );
    let payload_id = manifest.payload_id;
    a.send_secure(b.identity().device_id(), manifest, vec![Some(src)])
        .await
        .unwrap();

    let row = inbox_row(&b, payload_id).await;
    assert_eq!(
        row.saved_paths,
        format!(
            "[{:?}]",
            b_dir.path().join("payload.bin").display().to_string()
        ),
        "saved_paths must be the JSON array of real destinations"
    );
    // And the path it names must be a file that exists, with the bytes.
    assert_eq!(
        std::fs::read(b_dir.path().join("payload.bin")).unwrap(),
        vec![7u8; 40_000]
    );

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

/// The negative case: a TEXT payload materialises nothing, so "[]" is a true
/// statement, not a placeholder.
#[tokio::test]
async fn a_received_text_records_an_empty_list() {
    let (a, b, _a_dir, _b_dir) = paired().await;
    let manifest = Manifest::new(
        PayloadKind::Text,
        DeviceRef {
            device_id: a.identity().device_id(),
            name: "a".into(),
        },
        vec![Item::text(0, "meet at 6")],
    );
    let payload_id = manifest.payload_id;
    a.send_secure(b.identity().device_id(), manifest, vec![])
        .await
        .unwrap();

    let row = inbox_row(&b, payload_id).await;
    assert_eq!(row.saved_paths, "[]", "a text payload saves no files");
    assert_eq!(row.summary, "meet at 6");

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

/// The event the UI sees must agree with the row: one event per settled item,
/// carrying the same path the inbox row records.
#[tokio::test]
async fn the_transfer_item_event_and_the_inbox_row_name_the_same_file() {
    let (a, b, a_dir, _b_dir) = paired().await;
    let mut events = b.events();
    let src = a_dir.path().join("same.bin");
    std::fs::write(&src, vec![3u8; 1000]).unwrap();
    let item = Item::from_file(0, &src, CHUNK_SIZE_DEFAULT).unwrap();
    let manifest = Manifest::new(
        PayloadKind::Media,
        DeviceRef {
            device_id: a.identity().device_id(),
            name: "a".into(),
        },
        vec![item],
    );
    let payload_id = manifest.payload_id;
    a.send_secure(b.identity().device_id(), manifest, vec![Some(src)])
        .await
        .unwrap();

    let mut event_path = None;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match tokio::time::timeout_at(deadline, events.recv()).await {
            Ok(Ok(EngineEvent::TransferItem {
                dest_path: Some(p), ..
            })) => {
                event_path = Some(p);
                break;
            }
            Ok(Ok(EngineEvent::InboxReceived(_))) => break,
            Ok(Ok(_)) => continue,
            Ok(Err(_)) => panic!("b event stream closed before TransferItem"),
            Err(_) => panic!("timed out waiting for TransferItem"),
        }
    }
    let row = inbox_row(&b, payload_id).await;
    let p = event_path.expect("InboxReceived arrived before TransferItem; ordering regressed");
    assert_eq!(row.saved_paths, format!("[{:?}]", p));

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}
