use super::Db;
use crate::error::Result;

/// The counts of the rows that startup reconciliation moved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ReconcileReport {
    pub transfers_reset: usize,
    pub items_reset: usize,
    pub outbox_reset: usize,
}

impl Db {
    /// Restore a consistent state after a restart.
    ///
    /// A process that stops in the middle of a transfer leaves `active`,
    /// `awaiting_ack`, `paused`, `receiving`, and `verifying` rows. This call
    /// moves each of them back to a workable state. The call flips row states
    /// only. The persisted `chunk_state` bitmap (Phase 3) stays correct, so the
    /// sender and the receiver resume from the gaps that `gaps_to_nack` gives.
    pub fn reconcile_on_startup(&self) -> Result<ReconcileReport> {
        let transfers_reset = self.reset_inflight_transfers()?;
        let items_reset = self.conn().execute(
            "UPDATE transfer_items SET state = 'pending' WHERE state IN ('receiving','verifying')",
            [],
        )?;
        let outbox_reset = self.reset_inflight_outbox()?;
        Ok(ReconcileReport {
            transfers_reset,
            items_reset,
            outbox_reset,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::outbox::OutboxRow;
    use crate::store::transfers::{ItemRow, TransferRow};

    fn transfer(state: &str) -> TransferRow {
        TransferRow {
            transfer_id: [1u8; 16],
            payload_id: [1u8; 16],
            peer_device_id: [2u8; 16],
            direction: "out".into(),
            kind: "media".into(),
            state: state.into(),
            bytes_total: 10,
            bytes_done: 4,
            item_count: 1,
            created_at: 0,
            updated_at: 0,
            manifest: vec![1],
            error: None,
        }
    }

    fn item(state: &str) -> ItemRow {
        ItemRow {
            transfer_id: [1u8; 16],
            item_index: 0,
            item_type: "document".into(),
            name: Some("f.bin".into()),
            mime: None,
            size: Some(10),
            hash: None,
            dest_path: None,
            state: state.into(),
        }
    }

    fn outbox() -> OutboxRow {
        OutboxRow {
            id: [3u8; 16],
            payload_id: [3u8; 16],
            peer_device_id: [2u8; 16],
            manifest: vec![1],
            total_bytes: 10,
            attempts: 0,
            next_attempt_at: 0,
            state: "pending".into(),
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn startup_reconciliation_resets_all_inflight_work() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.upsert_transfer(&transfer("active")).unwrap();
        db.upsert_item(&item("receiving")).unwrap();
        db.enqueue_outbox(&outbox()).unwrap();
        db.mark_outbox_sending(&[3u8; 16]).unwrap();

        let report = db.reconcile_on_startup().unwrap();
        assert_eq!(report.transfers_reset, 1);
        assert_eq!(report.items_reset, 1);
        assert_eq!(report.outbox_reset, 1);

        assert_eq!(
            db.get_transfer(&[1u8; 16]).unwrap().unwrap().state,
            "queued"
        );
        assert_eq!(
            db.due_outbox(i64::MAX).unwrap().len(),
            1,
            "the outbox row drains again"
        );
    }
}
