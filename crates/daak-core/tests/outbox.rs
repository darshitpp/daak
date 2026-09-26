use daak_core::store::Db;

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
