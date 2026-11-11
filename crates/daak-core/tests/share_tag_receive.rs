// The receiver exposes a valid share tag on the inbox entry. The tag is
// computed when the transfer arrives. It is not stored.
//
// These tests bind loopback sockets. Under a sandbox that denies socket(2)
// they fail with EPERM. That is the sandbox, not a defect.
use std::sync::Arc;

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::engine::{Engine, EngineConfig, EngineEvent};
use daak_core::manifest::{DeviceRef, Item, Manifest, PayloadKind, CHUNK_SIZE_DEFAULT};
use daak_core::pairing::PairMode;
use daak_core::store::inbox::InboxRow;
use daak_core::store::Db;
use tempfile::TempDir;

const SHARE: &str = "00112233445566778899aabbccddeeff";

async fn engine(name: &str, out: std::path::PathBuf) -> Engine {
    std::env::set_var("DAAK_MDNS_OFF_LAN", "1");
    let store = Arc::new(MemorySecretStore::default());
    let identity = import_from_store(store.as_ref()).unwrap();
    let db = Arc::new(Db::open_in_memory().unwrap());
    db.migrate().unwrap();
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

async fn paired() -> (Arc<Engine>, Arc<Engine>, TempDir, TempDir) {
    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    let a = Arc::new(engine("a", d1.path().to_path_buf()).await);
    let b = Arc::new(engine("b", d2.path().to_path_buf()).await);
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
    (a, b, d1, d2)
}

fn file_item(
    dir: &TempDir,
    index: u32,
    name: &str,
    tag: Option<(&str, &str)>,
) -> (Item, std::path::PathBuf) {
    let p = dir.path().join(name);
    std::fs::write(&p, name.as_bytes()).unwrap();
    let mut item = Item::from_file(index, &p, CHUNK_SIZE_DEFAULT).unwrap();
    if let Some((share, batch)) = tag {
        item.attrs
            .insert("share".into(), ciborium::value::Value::Text(share.into()));
        item.attrs
            .insert("batch".into(), ciborium::value::Value::Text(batch.into()));
    }
    (item, p)
}

/// Sends the items from A to B. Returns the `InboxReceived` row and the row
/// that `list_inbox` gives later.
async fn receive(items: Vec<(Item, std::path::PathBuf)>) -> (InboxRow, InboxRow) {
    let (a, b, _d1, _d2) = paired().await;
    let mut rx = b.events();
    let (items, paths): (Vec<_>, Vec<_>) = items.into_iter().unzip();
    let manifest = Manifest::new(
        PayloadKind::Media,
        DeviceRef {
            device_id: a.identity().device_id(),
            name: "a".into(),
        },
        items,
    );
    let id = manifest.payload_id;
    a.send_secure(
        b.identity().device_id(),
        manifest,
        paths.into_iter().map(Some).collect(),
    )
    .await
    .unwrap();
    let told = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            match rx.recv().await.unwrap() {
                EngineEvent::InboxReceived(r) if r.id == id => return r,
                _ => {}
            }
        }
    })
    .await
    .expect("no InboxReceived event");
    let listed = b
        .list_inbox()
        .unwrap()
        .into_iter()
        .find(|r| r.id == id)
        .unwrap();
    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
    (told, listed)
}

#[tokio::test]
async fn a_valid_tag_gives_share_and_batch_on_the_inbox_entry() {
    let d = tempfile::tempdir().unwrap();
    let items = vec![
        file_item(&d, 0, "a.bin", Some((SHARE, "2/7"))),
        file_item(&d, 1, "b.bin", Some((SHARE, "2/7"))),
    ];
    let (told, _) = receive(items).await;
    assert_eq!(told.share.as_deref(), Some(SHARE));
    assert_eq!(told.batch.as_deref(), Some("2/7"));
}

#[tokio::test]
async fn a_stored_row_read_with_list_inbox_has_no_tag() {
    let d = tempfile::tempdir().unwrap();
    let items = vec![file_item(&d, 0, "a.bin", Some((SHARE, "1/1")))];
    let (told, listed) = receive(items).await;
    assert_eq!(told.share.as_deref(), Some(SHARE));
    assert_eq!(listed.share, None);
    assert_eq!(listed.batch, None);
}

#[tokio::test]
async fn an_untagged_transfer_gives_none() {
    let d = tempfile::tempdir().unwrap();
    let (told, _) = receive(vec![file_item(&d, 0, "a.bin", None)]).await;
    assert_eq!((told.share, told.batch), (None, None));
}

#[tokio::test]
async fn an_invalid_tag_is_ignored() {
    let d = tempfile::tempdir().unwrap();
    let upper = SHARE.to_uppercase();
    let (told, _) = receive(vec![file_item(&d, 0, "a.bin", Some((&upper, "1/2")))]).await;
    assert_eq!((told.share, told.batch), (None, None));
}

#[tokio::test]
async fn one_tagged_item_and_one_untagged_binary_item_give_none() {
    let d = tempfile::tempdir().unwrap();
    let items = vec![
        file_item(&d, 0, "a.bin", Some((SHARE, "1/2"))),
        file_item(&d, 1, "b.bin", None),
    ];
    let (told, _) = receive(items).await;
    assert_eq!((told.share, told.batch), (None, None));
}

#[tokio::test]
async fn a_text_only_transfer_gives_none() {
    let (a, b, _d1, _d2) = paired().await;
    let mut rx = b.events();
    let manifest = Manifest::new(
        PayloadKind::Text,
        DeviceRef {
            device_id: a.identity().device_id(),
            name: "a".into(),
        },
        vec![Item::text(0, "hi")],
    );
    let id = manifest.payload_id;
    a.send_secure(b.identity().device_id(), manifest, vec![])
        .await
        .unwrap();
    let told = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            match rx.recv().await.unwrap() {
                EngineEvent::InboxReceived(r) if r.id == id => return r,
                _ => {}
            }
        }
    })
    .await
    .expect("no InboxReceived event");
    assert_eq!((told.share, told.batch), (None, None));
    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}
