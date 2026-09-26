use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;

use crate::error::Result;
use crate::manifest::Manifest;
use crate::staging::Staging;
use crate::store::outbox::OutboxRow;
use crate::store::Db;

pub fn enqueue(
    db: &Db,
    staging: &Staging,
    peer: &[u8; 16],
    manifest: &Manifest,
    files: &[PathBuf],
) -> Result<[u8; 16]> {
    // Stage every binary item so the source can be deleted safely. `files` is
    // indexed by ITEM index, not by position among the binary items (the sender
    // and the CLI both look it up with `item.index as usize`).
    for item in manifest.binary_items() {
        if let Some(src) = files.get(item.index as usize) {
            staging.stage(&manifest.payload_id, src)?;
        }
    }
    let mut id = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut id);
    let now = crate::manifest::now_ms() as i64 / 1000;
    db.enqueue_outbox(&OutboxRow {
        id,
        payload_id: manifest.payload_id,
        peer_device_id: *peer,
        manifest: manifest.to_cbor()?,
        total_bytes: manifest.items.iter().filter_map(|i| i.size).sum::<u64>(),
        attempts: 0,
        next_attempt_at: now,
        state: "pending".into(),
        created_at: now,
        updated_at: now,
    })?;
    Ok(id)
}

pub struct OutboxWorker {
    tx: mpsc::Sender<[u8; 16]>,
    task: tokio::task::JoinHandle<()>,
}

impl OutboxWorker {
    pub fn spawn(db: Arc<Db>, drain: impl Fn(OutboxRow) + Send + 'static) -> Self {
        let (tx, mut rx) = mpsc::channel::<[u8; 16]>(64);
        let task = tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(5));
            // consume the immediate first tick so a drain is notify-driven, not poll-driven
            tick.tick().await;
            loop {
                tokio::select! {
                    peer = rx.recv() => {
                        // Every sender dropped (engine gone): stop, otherwise this
                        // task ticks forever holding the last Arc<Db>.
                        if peer.is_none() { return; }
                    }
                    _ = tick.tick() => {}
                }
                let now = crate::manifest::now_ms() as i64 / 1000;
                if let Ok(due) = db.due_outbox(now) {
                    for row in due {
                        // Only the caller that won the pending->sending claim drains
                        // it, so two concurrent workers cannot deliver a row twice.
                        if db.mark_outbox_sending(&row.id).unwrap_or(false) {
                            drain(row);
                        }
                    }
                }
            }
        });
        Self { tx, task }
    }

    pub fn notify_peer_online(&self, peer: [u8; 16]) {
        let _ = self.tx.try_send(peer);
    }

    pub fn shutdown(self) {
        self.task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Deviation from the brief: build the manifest with ONE binary item
    // (Item::from_file) so enqueue actually stages a file, then assert both the
    // pending row and the staged file. Manifest::text has no binary items and
    // would stage nothing, making the brief's staging-dir assertion vacuous.
    #[test]
    fn enqueue_stages_files_and_creates_pending_row() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        let root = tempfile::tempdir().unwrap();
        let staging = Staging::new(root.path().to_path_buf());
        let src = tempfile::tempdir().unwrap();
        let f = src.path().join("a.bin");
        std::fs::write(&f, b"data").unwrap();

        let manifest = crate::manifest::Manifest::batch(
            crate::manifest::DeviceRef {
                device_id: [9u8; 16],
                name: "local".into(),
            },
            vec![
                crate::manifest::Item::from_file(0, &f, crate::manifest::CHUNK_SIZE_DEFAULT)
                    .unwrap(),
            ],
        )
        .unwrap();

        enqueue(
            &db,
            &staging,
            &[9u8; 16],
            &manifest,
            std::slice::from_ref(&f),
        )
        .unwrap();

        let due = db.due_outbox(crate::manifest::now_ms() as i64).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].state, "pending");
        assert!(staging.staged_path(&manifest.payload_id, "a.bin").exists());
    }

    // R-A: the brief's only test never exercises the worker loop, so the drain
    // itself is untested. No sockets here: the drain closure is a plain Fn.
    #[tokio::test]
    async fn worker_drains_due_row_on_notify() {
        let db = Arc::new(Db::open_in_memory().unwrap());
        db.migrate().unwrap();
        let root = tempfile::tempdir().unwrap();
        let staging = Staging::new(root.path().to_path_buf());

        let manifest = crate::manifest::Manifest::text("queued");
        let row_id = enqueue(&db, &staging, &[9u8; 16], &manifest, &[]).unwrap();

        let (seen_tx, mut seen_rx) = tokio::sync::mpsc::channel::<[u8; 16]>(1);
        let worker = OutboxWorker::spawn(db.clone(), move |row| {
            let _ = seen_tx.try_send(row.id);
        });
        worker.notify_peer_online([9u8; 16]);

        let drained = tokio::time::timeout(std::time::Duration::from_secs(5), seen_rx.recv())
            .await
            .expect("worker did not drain within 5s")
            .expect("drain channel closed");
        assert_eq!(drained, row_id);

        // 'sending' is not 'pending', so the row leaves the due set.
        assert!(db.due_outbox(i64::MAX).unwrap().is_empty());
        worker.shutdown();
    }

    // Mixed batch: the file is item index 1 but the FIRST (only) binary item, so
    // the old enumerate()-over-binary_items() staged files[0] -- the wrong slot.
    #[test]
    fn enqueue_stages_the_file_of_a_mixed_text_file_batch() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        let root = tempfile::tempdir().unwrap();
        let staging = Staging::new(root.path().to_path_buf());
        let src = tempfile::tempdir().unwrap();
        let f = src.path().join("b.bin");
        std::fs::write(&f, b"data").unwrap();

        let manifest = crate::manifest::Manifest::batch(
            crate::manifest::DeviceRef {
                device_id: [9u8; 16],
                name: "local".into(),
            },
            vec![
                crate::manifest::Item::text(0, "note"),
                crate::manifest::Item::from_file(1, &f, crate::manifest::CHUNK_SIZE_DEFAULT)
                    .unwrap(),
            ],
        )
        .unwrap();

        // `files` is indexed by item index: slot 0 empty, slot 1 the file.
        let mut files: Vec<PathBuf> = vec![PathBuf::new()];
        files.push(f.clone());
        enqueue(&db, &staging, &[9u8; 16], &manifest, &files).unwrap();

        assert!(
            staging.staged_path(&manifest.payload_id, "b.bin").exists(),
            "the file item (index 1) must be the one staged"
        );
    }
}
