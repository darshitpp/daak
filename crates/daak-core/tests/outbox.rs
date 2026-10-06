use daak_core::manifest::{DeviceRef, Item, Manifest, CHUNK_SIZE_DEFAULT};
use daak_core::staging::Staging;
use daak_core::store::Db;

/// W-FW-2: the exit criterion "an offline-queued item auto-delivers when the
/// peer's presence returns", end to end through a real Engine pair -- queueing,
/// the outbox worker, the session registry, and real delivery over TCP.
///
/// Binds sockets, so it needs an unsandboxed run.
#[tokio::test]
async fn an_offline_queued_item_auto_delivers_when_the_peer_comes_back() {
    use daak_core::engine::{Engine, EngineConfig};
    use daak_core::pairing::PairMode;
    use std::sync::Arc;
    use std::time::Duration;

    async fn engine(name: &str, out: std::path::PathBuf) -> (Engine, Arc<Db>) {
        let store = Arc::new(daak_core::crypto::secret_store::MemorySecretStore::default());
        let identity = daak_core::crypto::identity::import_from_store(store.as_ref()).unwrap();
        let db = Arc::new(Db::open_in_memory().unwrap());
        db.migrate().unwrap();
        let caller_db = db.clone();
        (
            Engine::start(EngineConfig {
                display_name: name.into(),
                listen_addr: "127.0.0.1:0".parse().unwrap(),
                out_dir: out,
                identity,
                db,
            })
            .await
            .unwrap(),
            caller_db,
        )
    }

    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    let (a_engine, a_db) = engine("a", d1.path().to_path_buf()).await;
    let a = Arc::new(a_engine);
    let b = Arc::new(engine("b", d2.path().to_path_buf()).await.0);

    let b_addr = b.local_addr();
    let b_id = b.pairing_bundle().await.identity.device_id;

    // Pair first, so the secure send below has a pairing row to authenticate
    // with.
    //
    // R42d changed what "unreachable" can mean here. Pairing used to leave A's
    // device map empty, so an unannounced address WAS the way to make the peer
    // unreachable -- and that was the bug: a paired peer could never receive a
    // send until mDNS said hello (measured on the desktop as a row at 7 of 8
    // attempts). Pairing now seeds the map with the address the handshake used,
    // so this test makes the peer unreachable the real way: a DEAD port on
    // loopback. Nothing answers there, and no announce can change that.
    b.offer_pairing(a.pairing_bundle().await, PairMode::Qr, None)
        .await
        .unwrap();
    let b_for_server = b.clone();
    let server = tokio::spawn(async move { b_for_server.accept_pairing_once().await.unwrap() });
    let (_sas, peer_id) = a.pair_with(b_addr, b.pairing_bundle().await).await.unwrap();
    server.await.unwrap();
    assert_eq!(peer_id, b_id);
    // Override the address pairing just seeded with one nothing listens on.
    a.note_peer(b_id, "b", "127.0.0.1:1".parse().unwrap()).await;

    let src = tempfile::tempdir().unwrap();
    let path = src.path().join("queued.bin");
    let payload: Vec<u8> = (0..120_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(&path, &payload).unwrap();
    let manifest = Manifest::batch(
        DeviceRef {
            device_id: a.identity().device_id(),
            name: "a".into(),
        },
        vec![Item::from_file(0, &path, CHUNK_SIZE_DEFAULT).unwrap()],
    )
    .unwrap();
    let payload_id = manifest.payload_id;

    // Queue it while the peer is unreachable.
    let id = a
        .enqueue_outbox_send(b_id, manifest, vec![path])
        .await
        .unwrap();
    assert_eq!(id, payload_id);

    // Wait for the drain to actually TRY and fail: an unresolvable peer is a
    // failed attempt, not a silent no-op, and attempts >= 1 is the proof that
    // the row really went through the worker.
    for _ in 0..100 {
        if a_db.get_outbox(&payload_id).unwrap().unwrap().attempts >= 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let row = a_db.get_outbox(&payload_id).unwrap().unwrap();
    assert!(
        row.attempts >= 1,
        "the drain should have attempted the row once and failed to reach the dead port"
    );
    assert_eq!(
        row.state, "pending",
        "an unreachable peer must leave the row queued, not delivered"
    );
    assert!(
        !d2.path().join("queued.bin").exists(),
        "nothing may land on B before the peer is reachable"
    );

    // The peer becomes reachable. In production that is the discovery/presence
    // handler: it records the address in the device map (engine.rs:308) AND
    // calls outbox.notify_peer_online (engine.rs:316/330). note_peer is the
    // one-shot equivalent -- it seeds the same map entry and, since this wave,
    // issues the same notify.
    a.note_peer(b_id, "b", b_addr).await;

    // The wall clock here is the REAL retry backoff, not a sleep: the failed
    // attempt above set next_attempt_at ~30s out (backoff_delay(1) = 15*2), and
    // a notify cannot claim a row that is not due yet. That is correct
    // production behaviour -- an unreachable peer must not be hammered -- so the
    // test waits it out rather than shortening the schedule to look fast.
    for _ in 0..2000 {
        let done = a_db
            .get_outbox(&id)
            .unwrap()
            .map(|r| r.state == "done")
            .unwrap_or(false);
        if done && d2.path().join("queued.bin").exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    assert_eq!(
        std::fs::read(d2.path().join("queued.bin")).unwrap(),
        payload,
        "the auto-delivered bytes must match, not just land"
    );
    assert_eq!(
        a_db.get_outbox(&id).unwrap().unwrap().state,
        "done",
        "the row must settle to done once the Ack arrives"
    );

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

/// One binary item + a real file, so enqueue actually stages it.
fn binary_send(
    db: &Db,
    staging: &Staging,
    peer: [u8; 16],
    src: &std::path::PathBuf,
) -> ([u8; 16], Manifest) {
    let manifest = Manifest::batch(
        DeviceRef {
            device_id: [9u8; 16],
            name: "local".into(),
        },
        vec![Item::from_file(0, src, CHUNK_SIZE_DEFAULT).unwrap()],
    )
    .unwrap();
    let id = daak_core::outbox::enqueue(db, staging, &peer, &manifest, std::slice::from_ref(src))
        .unwrap();
    (id, manifest)
}

#[test]
fn outbox_happy_path_pending_sending_awaiting_ack_done() {
    let db = Db::open_in_memory().unwrap();
    db.migrate().unwrap();
    let manifest = daak_core::manifest::Manifest::text("hi");
    let root = tempfile::tempdir().unwrap();
    let staging = daak_core::staging::Staging::new(root.path().to_path_buf());
    let id = daak_core::outbox::enqueue(&db, &staging, &[5u8; 16], &manifest, &[]).unwrap();

    assert_eq!(db.get_outbox(&id).unwrap().unwrap().state, "pending");
    db.mark_outbox_sending(&id).unwrap();
    assert_eq!(db.get_outbox(&id).unwrap().unwrap().state, "sending");
    db.mark_outbox_awaiting_ack(&id).unwrap();
    assert_eq!(db.get_outbox(&id).unwrap().unwrap().state, "awaiting_ack");
    db.mark_outbox_done(&id).unwrap();
    assert_eq!(db.get_outbox(&id).unwrap().unwrap().state, "done");
    assert!(db.due_outbox(i64::MAX).unwrap().is_empty());
}

#[test]
fn cancel_and_retry_reject_an_unknown_transfer_id() {
    let db = Db::open_in_memory().unwrap();
    db.migrate().unwrap();

    // R-T10-3: every UPDATE in cancel/retry matches zero rows for an unknown
    // id, so without the get_outbox guard both would silently 'succeed'.
    let unknown = [42u8; 16];
    assert!(db.get_outbox(&unknown).unwrap().is_none());
    let root = tempfile::tempdir().unwrap();
    let staging = Staging::new(root.path().to_path_buf());
    assert!(matches!(
        daak_core::engine::cancel_with(&db, &staging, unknown),
        Err(daak_core::error::CoreError::Protocol(_))
    ));
    assert!(matches!(
        daak_core::engine::retry_with(&db, unknown),
        Err(daak_core::error::CoreError::Protocol(_))
    ));
}

#[test]
fn cancel_fails_the_row_removes_staging_and_retry_rearms_it() {
    let db = Db::open_in_memory().unwrap();
    db.migrate().unwrap();
    let root = tempfile::tempdir().unwrap();
    let staging = Staging::new(root.path().to_path_buf());
    let src_dir = tempfile::tempdir().unwrap();
    let f = src_dir.path().join("a.bin");
    std::fs::write(&f, b"data").unwrap();
    let (id, manifest) = binary_send(&db, &staging, [6u8; 16], &f);
    let staged = staging.staged_path(&manifest.payload_id, "a.bin");
    assert!(staged.exists(), "enqueue staged the file");

    daak_core::engine::cancel_with(&db, &staging, id).unwrap();
    assert_eq!(db.get_outbox(&id).unwrap().unwrap().state, "failed");
    assert!(!staged.exists(), "cancel must not leak the staged file");
    assert!(
        db.due_outbox(i64::MAX).unwrap().is_empty(),
        "a failed row is not due"
    );

    let peer = daak_core::engine::retry_with(&db, id).unwrap().unwrap();
    assert_eq!(peer, [6u8; 16], "retry reports the peer to notify");
    assert_eq!(db.get_outbox(&id).unwrap().unwrap().state, "pending");
    assert_eq!(db.due_outbox(i64::MAX).unwrap().len(), 1);

    db.delete_outbox(&id).unwrap();
    assert!(db.get_outbox(&id).unwrap().is_none());
}

#[test]
fn retry_leaves_a_sending_or_done_row_alone() {
    let db = Db::open_in_memory().unwrap();
    db.migrate().unwrap();
    let root = tempfile::tempdir().unwrap();
    let staging = Staging::new(root.path().to_path_buf());
    let manifest = Manifest::text("hi");
    let id = daak_core::outbox::enqueue(&db, &staging, &[6u8; 16], &manifest, &[]).unwrap();

    db.mark_outbox_sending(&id).unwrap();
    assert_eq!(
        daak_core::engine::retry_with(&db, id).unwrap(),
        None,
        "a sending row must not be re-armed (double drain)"
    );
    assert_eq!(db.get_outbox(&id).unwrap().unwrap().state, "sending");

    // I-B: 'done' is only reachable from 'awaiting_ack'; the drain always walks
    // the full send -> awaiting_ack -> done, so the retry assertion below must
    // too (a direct sending -> done is exactly what the guard now blocks).
    db.mark_outbox_done(&id).unwrap();
    assert_eq!(
        db.get_outbox(&id).unwrap().unwrap().state,
        "sending",
        "done is not reachable from sending"
    );
    db.mark_outbox_awaiting_ack(&id).unwrap();
    db.mark_outbox_done(&id).unwrap();
    assert_eq!(daak_core::engine::retry_with(&db, id).unwrap(), None);
    assert_eq!(
        db.get_outbox(&id).unwrap().unwrap().state,
        "done",
        "a delivered row must not be duplicated"
    );
}

#[test]
fn settle_on_a_cancelled_row_is_a_no_op() {
    let db = Db::open_in_memory().unwrap();
    db.migrate().unwrap();
    let root = tempfile::tempdir().unwrap();
    let staging = Staging::new(root.path().to_path_buf());
    let manifest = Manifest::text("hi");
    let id = daak_core::outbox::enqueue(&db, &staging, &[7u8; 16], &manifest, &[]).unwrap();

    daak_core::engine::cancel_with(&db, &staging, id).unwrap();
    // A drain that already claimed the row settles after the cancel: it must not
    // re-pend the canceled row.
    db.mark_outbox_failed(&id, 100, 0).unwrap();
    let row = db.get_outbox(&id).unwrap().unwrap();
    assert_eq!(row.state, "failed");
    assert_eq!(row.attempts, 0, "no backoff was applied");
    assert!(db.due_outbox(i64::MAX).unwrap().is_empty());
}

#[test]
fn crash_recovery_requeues_inflight_outbox_row() {
    let db = Db::open_in_memory().unwrap();
    db.migrate().unwrap();
    let manifest = daak_core::manifest::Manifest::text("hello");
    let root = tempfile::tempdir().unwrap();
    let staging = daak_core::staging::Staging::new(root.path().to_path_buf());
    let id = daak_core::outbox::enqueue(&db, &staging, &[8u8; 16], &manifest, &[]).unwrap();
    db.mark_outbox_sending(&id).unwrap();
    assert!(
        db.due_outbox(i64::MAX).unwrap().is_empty(),
        "sending rows are not due"
    );

    // Startup path: requeue anything left mid-flight.
    let requeued = db.reset_inflight_outbox().unwrap();
    assert_eq!(requeued, 1);

    let recovered = db.due_outbox(i64::MAX).unwrap();
    assert_eq!(
        recovered.len(),
        1,
        "the interrupted row is delivered exactly once after restart"
    );
    assert_eq!(&recovered[0].id, &id);
}

// I-B: the success settle (awaiting_ack then done) used to be a bare UPDATE, so
// a drain that had already claimed the row could write 'done' over a cancel that
// landed mid-flight: the row read delivered and the staged files were gone.
#[test]
fn success_settle_cannot_overwrite_a_cancel() {
    let db = Db::open_in_memory().unwrap();
    db.migrate().unwrap();
    let root = tempfile::tempdir().unwrap();
    let staging = Staging::new(root.path().to_path_buf());
    let manifest = Manifest::text("hi");
    let id = daak_core::outbox::enqueue(&db, &staging, &[7u8; 16], &manifest, &[]).unwrap();

    // The drain claimed the row, the user canceled mid-flight, then the drain's
    // send completed and settled.
    db.mark_outbox_sending(&id).unwrap();
    daak_core::engine::cancel_with(&db, &staging, id).unwrap();
    db.mark_outbox_awaiting_ack(&id).unwrap();
    db.mark_outbox_done(&id).unwrap();

    let row = db.get_outbox(&id).unwrap().unwrap();
    assert_eq!(
        row.state, "failed",
        "a canceled row must not read delivered"
    );
    assert!(db.due_outbox(i64::MAX).unwrap().is_empty());
}

// C-1 / R-T10-11: the outbox primary key IS the payload id. A random row id made
// cancel/retry unreachable, because the only id any caller holds is
// manifest.payload_id (what send_secure_with returns and record_inbox stores as
// transfers.transfer_id).
#[test]
fn enqueue_id_is_the_payload_id_so_cancel_and_retry_are_reachable() {
    let db = Db::open_in_memory().unwrap();
    db.migrate().unwrap();
    let root = tempfile::tempdir().unwrap();
    let staging = Staging::new(root.path().to_path_buf());
    let src_dir = tempfile::tempdir().unwrap();
    let f = src_dir.path().join("a.bin");
    std::fs::write(&f, b"data").unwrap();
    let (id, manifest) = binary_send(&db, &staging, [6u8; 16], &f);

    assert_eq!(
        id, manifest.payload_id,
        "enqueue's return value is the payload id, the row's primary key"
    );
    let row = db.get_outbox(&manifest.payload_id).unwrap().unwrap();
    assert_eq!(row.id, manifest.payload_id);
    assert_eq!(row.payload_id, manifest.payload_id);

    // Round trip keyed on the id a caller actually holds.
    daak_core::engine::cancel_with(&db, &staging, manifest.payload_id).unwrap();
    assert_eq!(
        db.get_outbox(&manifest.payload_id).unwrap().unwrap().state,
        "failed"
    );
    let peer = daak_core::engine::retry_with(&db, manifest.payload_id)
        .unwrap()
        .unwrap();
    assert_eq!(peer, [6u8; 16]);
    assert_eq!(
        db.get_outbox(&manifest.payload_id).unwrap().unwrap().state,
        "pending"
    );
}
