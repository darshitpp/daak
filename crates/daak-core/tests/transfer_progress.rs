// P4 Task 12. The engine reports transfer progress on BOTH sides.
//
// The thread progress bar stayed at 0% until the transfer ended, because the
// engine declared EngineEvent::TransferProgress with no send site. The sender
// and the receiver both call on_progress per chunk; this test proves the engine
// now turns those calls into events and into a stored bytes_done.
//
// Binds sockets, so it needs an unsandboxed run.

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::engine::{Engine, EngineConfig, EngineEvent};
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

/// The host receives; the joiner sends. Paired over the published address.
async fn paired(
    recv_dir: &std::path::Path,
    join_dir: &std::path::Path,
) -> (Arc<Engine>, Arc<Db>, Arc<Engine>, Arc<Db>) {
    let (host, host_db) = engine("host", recv_dir.to_path_buf()).await;
    let (join, join_db) = engine("joiner", join_dir.to_path_buf()).await;
    let host_addr = daak_core::discovery::host_lan_addr(host.local_addr().port())
        .expect("this host owns a LAN interface");
    host.offer_inbound_pairing(PairMode::Qr).await.unwrap();
    let accepted = tokio::spawn({
        let host = host.clone();
        async move { host.accept_pairing_once().await.unwrap() }
    });
    join.pair_with(host_addr, host.pairing_bundle().await)
        .await
        .unwrap();
    accepted.await.unwrap();
    (host, host_db, join, join_db)
}

/// Collect TransferProgress events until the sender's transfers row is done.
async fn collect_progress(
    sender_events: &mut tokio::sync::broadcast::Receiver<EngineEvent>,
    receiver_events: &mut tokio::sync::broadcast::Receiver<EngineEvent>,
    join: &Arc<Engine>,
    id: [u8; 16],
) -> (Vec<(u64, u64)>, Vec<(u64, u64)>) {
    let mut sender_seen: Vec<(u64, u64)> = Vec::new();
    let mut receiver_seen: Vec<(u64, u64)> = Vec::new();
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if let Ok(Ok(EngineEvent::TransferProgress {
                transfer_id,
                bytes_done,
                bytes_total,
            })) = tokio::time::timeout(Duration::from_millis(100), sender_events.recv()).await
            {
                if transfer_id == id {
                    sender_seen.push((bytes_done, bytes_total));
                }
            }
            if let Ok(Ok(EngineEvent::TransferProgress {
                transfer_id,
                bytes_done,
                bytes_total,
            })) = tokio::time::timeout(Duration::from_millis(10), receiver_events.recv()).await
            {
                if transfer_id == id {
                    receiver_seen.push((bytes_done, bytes_total));
                }
            }
            if join
                .list_transfers(None, None)
                .unwrap_or_default()
                .iter()
                .any(|r| r.transfer_id == id && r.state == "done")
            {
                return;
            }
        }
    })
    .await
    .expect("the send never reached done");
    (sender_seen, receiver_seen)
}

fn assert_non_decreasing(seen: &[(u64, u64)], who: &str) {
    for pair in seen.windows(2) {
        assert!(
            pair[1].0 >= pair[0].0,
            "{who}: bytes_done went backwards: {seen:?}"
        );
    }
}

#[tokio::test]
async fn a_file_send_reports_progress_on_both_sides() {
    let join_dir = tempfile::tempdir().unwrap();
    let recv_dir = tempfile::tempdir().unwrap();
    let payload_dir = tempfile::tempdir().unwrap();
    let (host, host_db, join, join_db) = paired(recv_dir.path(), join_dir.path()).await;
    let host_id = host.pairing_bundle().await.identity.device_id;
    let (join_name, join_id) = join.self_profile().await;

    // A file larger than one chunk, so the gate has several calls to weigh.
    let size = CHUNK_SIZE_DEFAULT as usize * 5;
    let file = payload_dir.path().join("five.bin");
    let bytes: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
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
    let total = size as u64;
    let id = join
        .enqueue_outbox_send(host_id, manifest, sources)
        .await
        .unwrap();

    let mut sender_events = join.events();
    let mut receiver_events = host.events();
    let (sender_seen, receiver_seen) =
        collect_progress(&mut sender_events, &mut receiver_events, &join, id).await;

    assert!(!sender_seen.is_empty(), "the sender reported no progress");
    assert!(
        !receiver_seen.is_empty(),
        "the receiver reported no progress"
    );
    assert_non_decreasing(&sender_seen, "sender");
    assert_non_decreasing(&receiver_seen, "receiver");
    assert_eq!(
        sender_seen.last().copied(),
        Some((total, total)),
        "the last sender event must be the whole file"
    );
    assert_eq!(
        receiver_seen.last().copied(),
        Some((total, total)),
        "the last receiver event must be the whole file"
    );
    // The stored value follows the events on both sides.
    assert_eq!(
        join_db.get_transfer(&id).unwrap().unwrap().bytes_done,
        total
    );
    assert_eq!(
        host_db.get_transfer(&id).unwrap().unwrap().bytes_done,
        total
    );
}

#[tokio::test]
async fn a_text_send_reports_no_progress() {
    let join_dir = tempfile::tempdir().unwrap();
    let recv_dir = tempfile::tempdir().unwrap();
    let (host, _host_db, join, _join_db) = paired(recv_dir.path(), join_dir.path()).await;
    let host_id = host.pairing_bundle().await.identity.device_id;
    let (join_name, join_id) = join.self_profile().await;

    let mut manifest = Manifest::text("hello over the lan");
    manifest.sender = DeviceRef {
        device_id: join_id,
        name: join_name.clone(),
    };
    let id = join
        .enqueue_outbox_send(host_id, manifest, vec![])
        .await
        .unwrap();

    let mut sender_events = join.events();
    let mut receiver_events = host.events();
    let (sender_seen, receiver_seen) =
        collect_progress(&mut sender_events, &mut receiver_events, &join, id).await;
    assert!(
        sender_seen.is_empty(),
        "a text payload moves no bytes: {sender_seen:?}"
    );
    assert!(
        receiver_seen.is_empty(),
        "a text payload moves no bytes: {receiver_seen:?}"
    );
}
