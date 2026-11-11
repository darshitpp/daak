use std::path::PathBuf;
use std::sync::Arc;

use daak_core::engine::{Engine, EngineConfig};
use daak_core::error::CoreError;
use daak_core::manifest::{DeviceRef, Manifest, CHUNK_SIZE_DEFAULT};
use daak_core::store::pairings::Pairing;
use daak_core::store::Db;

const SHARE: &str = "00112233445566778899aabbccddeeff";

async fn engine() -> (Engine, Arc<Db>, tempfile::TempDir) {
    let out = tempfile::tempdir().unwrap();
    std::env::set_var("DAAK_MDNS_OFF_LAN", "1");
    let db = Arc::new(Db::open_in_memory().unwrap());
    db.migrate().unwrap();
    let store = Arc::new(daak_core::crypto::secret_store::MemorySecretStore::default());
    let identity = daak_core::crypto::identity::import_from_store(store.as_ref()).unwrap();
    let engine = Engine::start(EngineConfig {
        display_name: "self".into(),
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        out_dir: out.path().to_path_buf(),
        identity,
        db: db.clone(),
    })
    .await
    .unwrap();
    (engine, db, out)
}

fn pair(db: &Db, peer: [u8; 16]) {
    db.upsert_pairing(&Pairing {
        peer_device_id: peer,
        state: "trusted".into(),
        paired_at: 0,
        verify_key: [1u8; 32],
        static_dh_pub: [2u8; 32],
        label: None,
    })
    .unwrap();
}

fn files(dir: &tempfile::TempDir, names: &[&str]) -> Vec<PathBuf> {
    names
        .iter()
        .map(|n| {
            let p = dir.path().join(n);
            std::fs::write(&p, n.as_bytes()).unwrap();
            p
        })
        .collect()
}

fn sender() -> DeviceRef {
    DeviceRef {
        device_id: [9u8; 16],
        name: "s".into(),
    }
}

fn text(v: &ciborium::value::Value) -> Option<&str> {
    match v {
        ciborium::value::Value::Text(t) => Some(t.as_str()),
        _ => None,
    }
}

#[tokio::test]
async fn a_tagged_send_writes_share_and_batch_on_every_item() {
    let (engine, db, _out) = engine().await;
    let peer = [5u8; 16];
    pair(&db, peer);
    let dir = tempfile::tempdir().unwrap();
    let paths = files(&dir, &["a.bin", "b.bin"]);
    let id = engine
        .send_files_tagged(peer, paths, SHARE.into(), "2/7".into(), 0)
        .await
        .unwrap();
    let row = db.get_outbox(&id).unwrap().unwrap();
    let manifest = Manifest::from_cbor(&row.manifest).unwrap();
    assert_eq!(manifest.items.len(), 2);
    for item in &manifest.items {
        assert_eq!(item.attrs.get("share").and_then(text), Some(SHARE));
        assert_eq!(item.attrs.get("batch").and_then(text), Some("2/7"));
    }
}

#[tokio::test]
async fn a_tagged_folder_keeps_path_and_group() {
    let (engine, db, _out) = engine().await;
    let peer = [5u8; 16];
    pair(&db, peer);
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("pics");
    std::fs::create_dir(&folder).unwrap();
    std::fs::write(folder.join("x.bin"), b"x").unwrap();
    let id = engine
        .send_files_tagged(peer, vec![folder], SHARE.into(), "1/1".into(), 0)
        .await
        .unwrap();
    let row = db.get_outbox(&id).unwrap().unwrap();
    let manifest = Manifest::from_cbor(&row.manifest).unwrap();
    let item = &manifest.items[0];
    assert!(item.attrs.contains_key("path"));
    assert!(item.attrs.contains_key("group"));
    assert_eq!(item.attrs.get("share").and_then(text), Some(SHARE));
}

#[test]
fn the_payload_id_is_the_same_for_the_same_share_k_and_attempt_and_differs_for_another_attempt() {
    let dir = tempfile::tempdir().unwrap();
    let paths = files(&dir, &["a.bin"]);
    let build = |k: u32, attempt: u32| {
        daak_core::manifest::from_picked_paths_tagged(
            sender(),
            &paths,
            CHUNK_SIZE_DEFAULT,
            SHARE,
            k,
            3,
            attempt,
        )
        .unwrap()
        .0
        .payload_id
    };
    assert_eq!(build(1, 0), build(1, 0));
    assert_ne!(build(1, 0), build(1, 1));
    assert_ne!(build(1, 0), build(2, 0));
}

#[tokio::test]
async fn a_repeated_tagged_send_returns_the_existing_row_and_adds_none() {
    let (engine, db, _out) = engine().await;
    let peer = [5u8; 16];
    pair(&db, peer);
    let dir = tempfile::tempdir().unwrap();
    let paths = files(&dir, &["a.bin"]);
    let first = engine
        .send_files_tagged(peer, paths.clone(), SHARE.into(), "1/3".into(), 0)
        .await
        .unwrap();
    let second = engine
        .send_files_tagged(peer, paths.clone(), SHARE.into(), "1/3".into(), 0)
        .await
        .unwrap();
    assert_eq!(first, second);
    assert_eq!(db.count_outbox_for_peer(&peer).unwrap(), 1);
    let third = engine
        .send_files_tagged(peer, paths, SHARE.into(), "1/3".into(), 1)
        .await
        .unwrap();
    assert_ne!(first, third);
    assert_eq!(db.count_outbox_for_peer(&peer).unwrap(), 2);
}

async fn refused(share: &str, batch: &str) -> bool {
    let (engine, db, _out) = engine().await;
    let peer = [5u8; 16];
    pair(&db, peer);
    let dir = tempfile::tempdir().unwrap();
    let paths = files(&dir, &["a.bin"]);
    match engine
        .send_files_tagged(peer, paths, share.into(), batch.into(), 0)
        .await
    {
        Err(CoreError::Protocol(msg)) => {
            assert!(!msg.contains(share) || share.is_empty());
            assert!(!msg.contains(batch));
            db.count_outbox_for_peer(&peer).unwrap() == 0
        }
        _ => false,
    }
}

#[tokio::test]
async fn share_of_31_or_33_characters_is_refused() {
    assert!(refused(&SHARE[..31], "1/3").await);
    assert!(refused(&format!("{SHARE}0"), "1/3").await);
}

#[tokio::test]
async fn share_with_a_non_hex_character_is_refused() {
    assert!(refused("0011223344556677889900aabbccddeg", "1/3").await);
}

#[tokio::test]
async fn batch_0_3_4_3_and_1_1001_are_refused() {
    assert!(refused(SHARE, "0/3").await);
    assert!(refused(SHARE, "4/3").await);
    assert!(refused(SHARE, "1/1001").await);
}
