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
            // The MANIFEST's name, not the source's leaf: a folder can hold two
            // files with the same leaf, and staging is a flat namespace.
            staging.stage(
                &manifest.payload_id,
                src,
                item.name.as_deref().unwrap_or_default(),
            )?;
        }
    }
    // R-T10-11: the row id IS the payload id. Every other transfer id in the
    // codebase is manifest.payload_id (send_secure_with returns it,
    // record_inbox stores it as transfers.transfer_id), so a random primary key
    // made cancel/retry unreachable -- no caller ever holds it. One payload is
    // enqueued for exactly one peer and Manifest::new mints a fresh random
    // payload_id per share, so the primary key stays unique.
    let id = manifest.payload_id;
    let now = crate::manifest::now_ms() as i64 / 1000;
    let total_bytes: u64 = manifest.items.iter().filter_map(|i| i.size).sum();
    // Encoded once and reused by BOTH inserts below: they store the identical
    // bytes, and a second to_cbor() is a second chance for the two rows to
    // disagree.
    let manifest_cbor = manifest.to_cbor()?;
    let row = OutboxRow {
        id,
        payload_id: manifest.payload_id,
        peer_device_id: *peer,
        manifest: manifest_cbor.clone(),
        total_bytes,
        attempts: 0,
        next_attempt_at: now,
        state: "pending".into(),
        created_at: now,
        updated_at: now,
    };
    // F4: the outbox table alone is not enough. A queued send is the one
    // transfer the user has NOT seen complete, so it is exactly the row the UI
    // lists and cancels; without it listTransfers cannot show a queued share and
    // cancel_with's set_transfer_state("canceled") updates zero rows, leaving
    // nothing that records the cancellation. The ON CONFLICT branch IS what
    // runs for a payload already present (it rewrites state/bytes_done/
    // updated_at); the reason that is safe is that Manifest::new mints a FRESH
    // random payload_id per share, so a queued outbound row never collides
    // with an inbound one in the first place.
    let transfer = crate::store::transfers::TransferRow {
        transfer_id: id,
        payload_id: manifest.payload_id,
        peer_device_id: *peer,
        direction: "out".into(),
        // The same lowercase-debug spelling transfer/receiver.rs uses.
        kind: format!("{:?}", manifest.kind).to_lowercase(),
        // spec 4.2's transfers.state enum; the outbox row above keeps its own
        // "pending" vocabulary, and "queued" is NOT a transfers state.
        state: "queued".into(),
        bytes_total: total_bytes,
        bytes_done: 0,
        item_count: manifest.items.len() as u32,
        created_at: now,
        updated_at: now,
        manifest: manifest_cbor,
        error: None,
    };
    // One transaction: a durable outbox row with no `transfers` row is a share
    // the UI cannot list and cancel cannot relabel.
    db.enqueue_outbox_with_transfer(&row, &transfer)?;
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

    /// Stop the worker. Takes &self, NOT self: the Engine holds the worker in
    /// an Arc (the per-row drain closures need it) and reaches shutdown through
    /// &self, so consuming it here would make the one call site impossible.
    /// Abort is enough for the TICKER. The per-row drain tasks it spawned are
    /// detached (see engine.rs), so abort does not reach them: an in-flight
    /// send can still finish and settle its row after shutdown. Harmless --
    /// every settle is guarded on a state transition, and the Arc<Db> frees
    /// when the last drain returns -- but the comment must not claim the
    /// shutdown is total, because it is not.
    pub fn shutdown(&self) {
        self.task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // F4: enqueue writes ONLY the outbox table, so a queued OUTBOUND share had
    // no `transfers` row at all. Two things were invisible because of it:
    // listTransfers could not show a queued send, and cancel_with's
    // set_transfer_state(&id, "canceled") updated zero rows -- so cancelling a
    // queued share left nothing behind to show it was cancelled. enqueue is the
    // one place every queued send passes through, so the row belongs here.
    #[test]
    fn a_queued_outbound_send_is_a_visible_transfers_row() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        let root = tempfile::tempdir().unwrap();
        let staging = Staging::new(root.path().to_path_buf());

        let manifest = crate::manifest::Manifest::text("queued");
        let id = enqueue(&db, &staging, &[9u8; 16], &manifest, &[]).unwrap();

        let rows = db.list_transfers(None, None).unwrap();
        let row = rows
            .iter()
            .find(|r| r.transfer_id == id)
            .expect("a queued outbound send must be visible via list_transfers");
        assert_eq!(row.direction, "out");
        // spec 4.2's transfers.state enum, NOT the outbox's "pending".
        assert_eq!(row.state, "queued");
        assert_eq!(row.payload_id, manifest.payload_id);
        assert_eq!(row.peer_device_id, [9u8; 16]);
        assert_eq!(row.item_count as usize, manifest.items.len());
        assert_eq!(row.bytes_done, 0);
        // The same lowercase-debug spelling transfer/receiver.rs uses.
        assert_eq!(row.kind, format!("{:?}", manifest.kind).to_lowercase());
        assert_eq!(
            row.bytes_total,
            manifest.items.iter().filter_map(|i| i.size).sum()
        );
        assert!(row.error.is_none());

        // The filter path the UI actually uses must find it too.
        let by_peer = db.list_transfers(None, Some(&[9u8; 16])).unwrap();
        assert!(by_peer.iter().any(|r| r.transfer_id == id));
    }

    // The other half of F4: cancel's set_transfer_state had nothing to update.
    #[test]
    fn cancelling_a_queued_send_marks_the_transfers_row_canceled() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        let root = tempfile::tempdir().unwrap();
        let staging = Staging::new(root.path().to_path_buf());

        let manifest = crate::manifest::Manifest::text("queued");
        let id = enqueue(&db, &staging, &[9u8; 16], &manifest, &[]).unwrap();

        crate::engine::cancel_with(&db, &staging, id).unwrap();
        let row = db
            .list_transfers(None, None)
            .unwrap()
            .into_iter()
            .find(|r| r.transfer_id == id)
            .expect("cancel must not delete the row a UI is still showing");
        // spec 4.2 spells it with ONE 'l'.
        assert_eq!(row.state, "canceled");
    }

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
