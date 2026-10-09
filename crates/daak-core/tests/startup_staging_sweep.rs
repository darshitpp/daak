// Spec 7.1: cleanup runs on startup. A crash can leave a staging dir with no
// live outbox row. Engine::start removes it and keeps a live row's files.
//
// Binds a socket, so it needs an unsandboxed run.

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::engine::{Engine, EngineConfig};
use daak_core::store::outbox::OutboxRow;
use daak_core::store::Db;
use std::sync::Arc;

#[tokio::test]
async fn start_removes_orphan_staging_and_keeps_a_live_rows_files() {
    let out = tempfile::tempdir().unwrap();
    let staging = out.path().join("staging");
    let orphan = staging.join(hex::encode([5u8; 16]));
    let live = staging.join(hex::encode([6u8; 16]));
    for d in [&orphan, &live] {
        std::fs::create_dir_all(d).unwrap();
        std::fs::write(d.join("a.txt"), b"x").unwrap();
    }

    let db = Arc::new(Db::open_in_memory().unwrap());
    db.migrate().unwrap();
    db.enqueue_outbox(&OutboxRow {
        id: [1u8; 16],
        payload_id: [6u8; 16],
        peer_device_id: [3u8; 16],
        manifest: vec![9],
        total_bytes: 1,
        attempts: 0,
        next_attempt_at: i64::MAX,
        state: "pending".into(),
        created_at: 0,
        updated_at: 0,
    })
    .unwrap();

    let store = Arc::new(MemorySecretStore::default());
    let identity = import_from_store(store.as_ref()).unwrap();
    let _engine = Engine::start(EngineConfig {
        display_name: "sweeper".into(),
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        out_dir: out.path().to_path_buf(),
        identity,
        db,
    })
    .await
    .unwrap();

    assert!(!orphan.exists(), "an orphan staging dir must be removed");
    assert!(live.exists(), "a live row's staging dir must stay");
}
