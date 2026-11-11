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
            &[5u8; 16],
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

#[test]
fn the_payload_id_differs_for_two_peers() {
    let dir = tempfile::tempdir().unwrap();
    let paths = files(&dir, &["a.bin"]);
    let build = |peer: [u8; 16]| {
        daak_core::manifest::from_picked_paths_tagged(
            sender(),
            &paths,
            CHUNK_SIZE_DEFAULT,
            &peer,
            SHARE,
            1,
            3,
            0,
        )
        .unwrap()
        .0
        .payload_id
    };
    assert_eq!(build([5u8; 16]), build([5u8; 16]));
    assert_ne!(build([5u8; 16]), build([6u8; 16]));
}

#[tokio::test]
async fn a_send_to_a_second_peer_queues_a_row_for_that_peer() {
    let (engine, db, _out) = engine().await;
    let (first_peer, second_peer) = ([5u8; 16], [6u8; 16]);
    pair(&db, first_peer);
    pair(&db, second_peer);
    let dir = tempfile::tempdir().unwrap();
    let paths = files(&dir, &["a.bin"]);
    let first = engine
        .send_files_tagged(first_peer, paths.clone(), SHARE.into(), "1/3".into(), 0)
        .await
        .unwrap();
    let second = engine
        .send_files_tagged(second_peer, paths, SHARE.into(), "1/3".into(), 0)
        .await
        .unwrap();
    assert_ne!(first, second);
    let row = db.get_outbox(&second).unwrap().unwrap();
    assert_eq!(row.peer_device_id, second_peer);
    assert_eq!(db.count_outbox_for_peer(&first_peer).unwrap(), 1);
    assert_eq!(db.count_outbox_for_peer(&second_peer).unwrap(), 1);
}

// The two calls run on 2 worker threads, so they can really race. Each round
// uses a new share, so a round cannot reuse the row of an earlier round.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_concurrent_tagged_sends_with_one_id_give_one_row() {
    let (engine, db, _out) = engine().await;
    let engine = Arc::new(engine);
    let peer = [5u8; 16];
    pair(&db, peer);
    let dir = tempfile::tempdir().unwrap();
    let paths = files(&dir, &["a.bin", "b.bin"]);
    for round in 0..25u32 {
        let share = format!("{round:032x}");
        let mut tasks = Vec::new();
        for _ in 0..2 {
            let (engine, paths, share) = (engine.clone(), paths.clone(), share.clone());
            tasks.push(tokio::spawn(async move {
                engine
                    .send_files_tagged(peer, paths, share, "1/3".into(), 0)
                    .await
            }));
        }
        let one = tasks.remove(0).await.unwrap().unwrap();
        let two = tasks.remove(0).await.unwrap().unwrap();
        assert_eq!(one, two, "round {round}");
        assert_eq!(
            db.count_outbox_for_peer(&peer).unwrap(),
            (round + 1) as u64,
            "round {round}: one new row"
        );
    }
}

#[tokio::test]
async fn an_orphan_staged_directory_with_no_row_does_not_block_a_retry() {
    let (engine, db, out) = engine().await;
    let peer = [5u8; 16];
    pair(&db, peer);
    let dir = tempfile::tempdir().unwrap();
    let paths = files(&dir, &["a.bin"]);
    let id = daak_core::manifest::tagged_payload_id(&peer, SHARE, 1, 0).unwrap();
    let orphan = out.path().join("staging").join(hex::encode(id));
    std::fs::create_dir_all(&orphan).unwrap();
    std::fs::write(orphan.join("item_0"), b"old").unwrap();
    std::fs::write(orphan.join("item_7"), b"stale").unwrap();
    let sent = engine
        .send_files_tagged(peer, paths, SHARE.into(), "1/3".into(), 0)
        .await
        .unwrap();
    assert_eq!(sent, id);
    assert_eq!(db.count_outbox_for_peer(&peer).unwrap(), 1);
    assert!(!orphan.join("item_7").exists());
    assert_eq!(std::fs::read(orphan.join("item_0")).unwrap(), b"a.bin");
}

#[tokio::test]
async fn a_failed_row_is_not_replaced_by_a_repeated_call() {
    let (engine, db, _out) = engine().await;
    let peer = [5u8; 16];
    pair(&db, peer);
    let dir = tempfile::tempdir().unwrap();
    let paths = files(&dir, &["a.bin"]);
    let first = engine
        .send_files_tagged(peer, paths.clone(), SHARE.into(), "1/3".into(), 0)
        .await
        .unwrap();
    db.mark_outbox_terminal_failed(&first, "test").unwrap();
    assert_eq!(db.get_outbox(&first).unwrap().unwrap().state, "failed");
    let again = engine
        .send_files_tagged(peer, paths, SHARE.into(), "1/3".into(), 0)
        .await
        .unwrap();
    assert_eq!(first, again);
    assert_eq!(db.get_outbox(&first).unwrap().unwrap().state, "failed");
    assert_eq!(count_all(&db, &peer), 1);
}

#[tokio::test]
async fn a_done_row_is_not_replaced_by_a_repeated_call() {
    let (engine, db, _out) = engine().await;
    let peer = [5u8; 16];
    pair(&db, peer);
    let dir = tempfile::tempdir().unwrap();
    let paths = files(&dir, &["a.bin"]);
    let first = engine
        .send_files_tagged(peer, paths.clone(), SHARE.into(), "1/3".into(), 0)
        .await
        .unwrap();
    db.mark_outbox_sending(&first).unwrap();
    db.mark_outbox_awaiting_ack(&first).unwrap();
    db.mark_outbox_done(&first).unwrap();
    assert_eq!(db.get_outbox(&first).unwrap().unwrap().state, "done");
    let again = engine
        .send_files_tagged(peer, paths, SHARE.into(), "1/3".into(), 0)
        .await
        .unwrap();
    assert_eq!(first, again);
    assert_eq!(db.get_outbox(&first).unwrap().unwrap().state, "done");
    assert_eq!(count_all(&db, &peer), 1);
}

#[tokio::test]
async fn an_upper_case_share_is_stored_in_lower_case_with_the_same_id() {
    let (engine, db, _out) = engine().await;
    let peer = [5u8; 16];
    pair(&db, peer);
    let dir = tempfile::tempdir().unwrap();
    let paths = files(&dir, &["a.bin"]);
    let upper = engine
        .send_files_tagged(
            peer,
            paths.clone(),
            SHARE.to_ascii_uppercase(),
            "1/3".into(),
            0,
        )
        .await
        .unwrap();
    let lower = engine
        .send_files_tagged(peer, paths, SHARE.into(), "1/3".into(), 0)
        .await
        .unwrap();
    assert_eq!(upper, lower);
    assert_eq!(db.count_outbox_for_peer(&peer).unwrap(), 1);
    let row = db.get_outbox(&upper).unwrap().unwrap();
    let manifest = Manifest::from_cbor(&row.manifest).unwrap();
    assert_eq!(
        manifest.items[0].attrs.get("share").and_then(text),
        Some(SHARE)
    );
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

fn count_all(db: &Db, peer: &[u8; 16]) -> usize {
    // Counts rows in every state, not only pending and sending.
    db.list_outbox_for_peer(peer).unwrap().len()
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
            assert_eq!(msg, "invalid share tag");
            assert_eq!(db.count_outbox_for_peer(&peer).unwrap(), 0);
            true
        }
        _ => false,
    }
}

#[tokio::test]
async fn a_batch_with_a_leading_zero_is_refused() {
    assert!(refused(SHARE, "01/03").await);
    assert!(refused(SHARE, "1/03").await);
    assert!(refused(SHARE, "0001/0003").await);
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
