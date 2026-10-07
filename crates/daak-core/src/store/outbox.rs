use super::Db;
use crate::error::Result;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxRow {
    pub id: [u8; 16],
    pub payload_id: [u8; 16],
    pub peer_device_id: [u8; 16],
    pub manifest: Vec<u8>,
    pub total_bytes: u64,
    pub attempts: u32,
    pub next_attempt_at: i64,
    pub state: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Exponential backoff with a 10-minute cap; jitter is caller-supplied seconds.
pub fn backoff_delay(attempts: u32, jitter: u64) -> i64 {
    backoff_delay_with(attempts, jitter, 600)
}

/// The same backoff curve as `backoff_delay`, with a caller-supplied cap in
/// seconds. The drain uses a higher cap when the device is in battery-saver
/// mode. `backoff_delay(attempts, jitter)` is exactly
/// `backoff_delay_with(attempts, jitter, 600)`.
pub fn backoff_delay_with(attempts: u32, jitter: u64, cap_secs: i64) -> i64 {
    let base = 15i64.saturating_mul(1i64 << attempts.min(6));
    (base + jitter as i64).min(cap_secs)
}

/// Shared by `enqueue_outbox` and the atomic two-table enqueue, so both write
/// byte-identical rows.
pub(crate) fn insert_outbox(c: &rusqlite::Connection, o: &OutboxRow) -> Result<()> {
    c.execute(
        r#"INSERT INTO outbox
             (id, payload_id, peer_device_id, manifest, total_bytes, attempts,
              next_attempt_at, state, created_at, updated_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)"#,
        rusqlite::params![
            &o.id[..],
            &o.payload_id[..],
            &o.peer_device_id[..],
            o.manifest,
            o.total_bytes as i64,
            o.attempts as i64,
            o.next_attempt_at,
            o.state,
            o.created_at,
            o.updated_at,
        ],
    )?;
    Ok(())
}

impl Db {
    pub fn enqueue_outbox(&self, o: &OutboxRow) -> Result<()> {
        insert_outbox(&self.conn(), o)
    }

    /// A queued share is ONE fact recorded in TWO tables. Inserting them in
    /// separate statements meant a failure between them left a durable,
    /// draining outbox row with no `transfers` row -- invisible to listTransfers
    /// and un-cancelable. One transaction, or neither.
    pub fn enqueue_outbox_with_transfer(
        &self,
        o: &OutboxRow,
        t: &crate::store::transfers::TransferRow,
    ) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        insert_outbox(&tx, o)?;
        crate::store::transfers::insert_transfer(&tx, t)?;
        tx.commit()?;
        Ok(())
    }

    pub fn due_outbox(&self, now: i64) -> Result<Vec<OutboxRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, payload_id, peer_device_id, manifest, total_bytes, attempts,
                    next_attempt_at, state, created_at, updated_at
               FROM outbox WHERE state = 'pending' AND next_attempt_at <= ?1
               ORDER BY created_at",
        )?;
        let rows = stmt.query_map(rusqlite::params![now], row_to_outbox)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The pending rows of ONE peer that are due now. A peer coming online
    /// drains only its own rows, so a returning peer does not re-run every
    /// other peer's queue.
    pub fn due_outbox_for_peer(&self, peer: &[u8; 16], now: i64) -> Result<Vec<OutboxRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, payload_id, peer_device_id, manifest, total_bytes, attempts,
                    next_attempt_at, state, created_at, updated_at
               FROM outbox WHERE state = 'pending' AND peer_device_id = ?2 AND next_attempt_at <= ?1
               ORDER BY created_at",
        )?;
        let rows = stmt.query_map(rusqlite::params![now, &peer[..]], row_to_outbox)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Every row of ONE peer, in any state. Used to prove a reconnect drained
    /// each queued row exactly once.
    pub fn list_outbox_for_peer(&self, peer: &[u8; 16]) -> Result<Vec<OutboxRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, payload_id, peer_device_id, manifest, total_bytes, attempts,
                    next_attempt_at, state, created_at, updated_at
               FROM outbox WHERE peer_device_id = ?1 ORDER BY created_at",
        )?;
        let rows = stmt.query_map(rusqlite::params![&peer[..]], row_to_outbox)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The number of rows for one peer that are not yet sent. Used by the
    /// presence queue-depth signal, so the UI can show "N queued".
    pub fn count_outbox_for_peer(&self, peer: &[u8; 16]) -> Result<u64> {
        let n: i64 = self.conn().query_row(
            "SELECT COUNT(1) FROM outbox WHERE peer_device_id = ?1 AND state IN ('pending','sending')",
            rusqlite::params![&peer[..]],
            |r| r.get(0),
        )?;
        Ok(n as u64)
    }

    pub fn get_outbox(&self, id: &[u8; 16]) -> Result<Option<OutboxRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, payload_id, peer_device_id, manifest, total_bytes, attempts,
                    next_attempt_at, state, created_at, updated_at
               FROM outbox WHERE id = ?1",
        )?;
        let mut rows = stmt.query(rusqlite::params![&id[..]])?;
        match rows.next()? {
            Some(r) => Ok(Some(row_to_outbox(r)?)),
            None => Ok(None),
        }
    }

    /// True only for the caller that actually moved the row. B2: the drain
    /// gates its `transfers` write on this, so a canceled row is never
    /// relabelled 'done' in the transfers table.
    pub fn mark_outbox_awaiting_ack(&self, id: &[u8; 16]) -> Result<bool> {
        let n = self.conn().execute(
            // Guards the "sending -> awaiting_ack" edge: a drain whose send
            // completed after the user canceled must not re-label the row.
            "UPDATE outbox SET state = 'awaiting_ack', updated_at = ?2
             WHERE id = ?1 AND state = 'sending'",
            rusqlite::params![&id[..], crate::manifest::now_ms() as i64 / 1000],
        )?;
        Ok(n > 0)
    }

    /// Terminal failure. `error` is logged, not persisted: the outbox table has
    /// no last_error column and this task does not add one (see task report).
    /// True only for the caller that actually moved the row; see
    /// `mark_outbox_awaiting_ack`.
    pub fn mark_outbox_terminal_failed(&self, id: &[u8; 16], error: &str) -> Result<bool> {
        tracing::warn!("outbox row {} failed permanently: {error}", hex::encode(id));
        let n = self.conn().execute(
            // Guards the "pending/sending -> failed" edge: cancel acts on a
            // pending row and the drain's give-up path on a sending one; a row
            // already "failed" or "done" is left alone, so a late terminal
            // settle cannot relabel a delivered row.
            "UPDATE outbox SET state = 'failed', updated_at = ?2
             WHERE id = ?1 AND state IN ('pending','sending')",
            rusqlite::params![&id[..], crate::manifest::now_ms() as i64 / 1000],
        )?;
        Ok(n > 0)
    }

    // ponytail: no engine caller yet; wire it in when outbox rows are pruned.
    pub fn delete_outbox(&self, id: &[u8; 16]) -> Result<()> {
        self.conn().execute(
            "DELETE FROM outbox WHERE id = ?1",
            rusqlite::params![&id[..]],
        )?;
        Ok(())
    }

    /// Remove every queued row for one peer. Returns the number of rows removed.
    ///
    /// Revocation is terminal: a revoked peer has no live session and no
    /// pairing, so a queued row for it can never drain. The purge is per-peer
    /// because revoke acts on a peer, not on one payload id.
    pub fn delete_outbox_for_peer(&self, peer: &[u8; 16]) -> Result<usize> {
        let n = self.conn().execute(
            "DELETE FROM outbox WHERE peer_device_id = ?1",
            rusqlite::params![&peer[..]],
        )?;
        Ok(n)
    }

    /// True only if the row was re-armed. Guards the "failed -> pending" edge of
    /// the outbox state machine: manual retry must not re-arm a row a drain has
    /// already claimed ("sending" -> double drain) or already delivered ("done"
    /// -> duplicate delivery). A canceled row lives in "failed", so cancel then
    /// retry is still the intended undo path.
    pub fn retry_outbox_now(&self, id: &[u8; 16]) -> Result<bool> {
        let now = crate::manifest::now_ms() as i64 / 1000;
        let n = self.conn().execute(
            "UPDATE outbox SET state = 'pending', attempts = 0, next_attempt_at = ?2, updated_at = ?2
             WHERE id = ?1 AND state IN ('pending','failed')",
            rusqlite::params![&id[..], now],
        )?;
        Ok(n > 0)
    }

    /// Claim a pending row for sending. True only for the caller that actually
    /// flipped 'pending' -> 'sending', so concurrent drains cannot both deliver
    /// the same row.
    pub fn mark_outbox_sending(&self, id: &[u8; 16]) -> Result<bool> {
        let n = self.conn().execute(
            "UPDATE outbox SET state = 'sending', updated_at = ?2 WHERE id = ?1 AND state = 'pending'",
            rusqlite::params![&id[..], crate::manifest::now_ms() as i64 / 1000],
        )?;
        Ok(n > 0)
    }

    /// Back off for another attempt. True only for the caller that actually
    /// moved the row; see `mark_outbox_awaiting_ack`.
    pub fn mark_outbox_failed(&self, id: &[u8; 16], now: i64, jitter: u64) -> Result<bool> {
        self.mark_outbox_failed_capped(id, now, jitter, 600)
    }

    /// `mark_outbox_failed` with a caller-supplied backoff cap. Battery-saver
    /// mode raises the cap so a retry battery drain is lower.
    pub fn mark_outbox_failed_capped(
        &self,
        id: &[u8; 16],
        now: i64,
        jitter: u64,
        cap_secs: i64,
    ) -> Result<bool> {
        let conn = self.conn();
        let attempts: u32 = conn
            .query_row(
                "SELECT attempts FROM outbox WHERE id = ?1",
                rusqlite::params![&id[..]],
                |r| r.get::<_, i64>(0),
            )
            .map(|v| v as u32)?;
        let next = now + backoff_delay_with(attempts + 1, jitter, cap_secs);
        // Guards the "sending -> failed" edge: a settle from a drain that lost
        // the claim (row since canceled or re-armed) must not re-pend the row.
        let n = conn.execute(
            "UPDATE outbox SET state = 'pending', attempts = attempts + 1, next_attempt_at = ?2, updated_at = ?3
             WHERE id = ?1 AND state = 'sending'",
            rusqlite::params![&id[..], next, now],
        )?;
        Ok(n > 0)
    }

    /// True only for the caller that actually moved the row; see
    /// `mark_outbox_awaiting_ack`.
    pub fn mark_outbox_done(&self, id: &[u8; 16]) -> Result<bool> {
        let n = self.conn().execute(
            // Guards the "awaiting_ack -> done" edge, same race as above.
            "UPDATE outbox SET state = 'done', updated_at = ?2
             WHERE id = ?1 AND state = 'awaiting_ack'",
            rusqlite::params![&id[..], crate::manifest::now_ms() as i64 / 1000],
        )?;
        Ok(n > 0)
    }

    /// Crash recovery: any outbox row left mid-flight becomes pending again.
    /// awaiting_ack is included now so a row interrupted mid-Ack (once
    /// mark_outbox_awaiting_ack lands) is not permanently invisible.
    pub fn reset_inflight_outbox(&self) -> Result<usize> {
        let n = self.conn().execute(
            "UPDATE outbox SET state = 'pending' WHERE state IN ('sending','awaiting_ack')",
            [],
        )?;
        Ok(n)
    }
}

/// Shared row mapping for `due_outbox` and `get_outbox` (R-T10-4: one copy).
fn row_to_outbox(r: &rusqlite::Row<'_>) -> rusqlite::Result<OutboxRow> {
    let id: Vec<u8> = r.get(0)?;
    let pid: Vec<u8> = r.get(1)?;
    let peer: Vec<u8> = r.get(2)?;
    let a = |v: Vec<u8>| -> rusqlite::Result<[u8; 16]> {
        v.try_into().map_err(|_| rusqlite::Error::InvalidQuery)
    };
    Ok(OutboxRow {
        id: a(id)?,
        payload_id: a(pid)?,
        peer_device_id: a(peer)?,
        manifest: r.get(3)?,
        total_bytes: r.get::<_, i64>(4)? as u64,
        attempts: r.get::<_, i64>(5)? as u32,
        next_attempt_at: r.get(6)?,
        state: r.get(7)?,
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row() -> OutboxRow {
        OutboxRow {
            id: [1u8; 16],
            payload_id: [2u8; 16],
            peer_device_id: [3u8; 16],
            manifest: vec![9],
            total_bytes: 100,
            attempts: 0,
            next_attempt_at: 0,
            state: "pending".into(),
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn due_outbox_respects_next_attempt_and_backoff_is_monotonic() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.enqueue_outbox(&row()).unwrap();
        assert_eq!(
            db.due_outbox(100).unwrap().len(),
            1,
            "newly queued is immediately due"
        );

        // First failure at now=100: backoff_delay(attempts+1 = 1, 0) = 15 * 2^1 = 30,
        // so next_attempt_at = 130.
        assert!(db.mark_outbox_sending(&[1u8; 16]).unwrap());
        db.mark_outbox_failed(&[1u8; 16], 100, 0).unwrap();
        assert_eq!(
            db.due_outbox(100).unwrap().len(),
            0,
            "not due before backoff elapses"
        );
        assert_eq!(db.due_outbox(129).unwrap().len(), 0);
        assert_eq!(
            db.due_outbox(130).unwrap().len(),
            1,
            "due once backoff elapses"
        );
        assert_eq!(db.due_outbox(999).unwrap().len(), 1);

        assert!(backoff_delay(1, 0) <= backoff_delay(2, 0));
        assert!(backoff_delay(9, 0) <= 600, "backoff must cap at 10 minutes");
    }

    #[test]
    fn done_outbox_is_not_due() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.enqueue_outbox(&row()).unwrap();
        // I-B: 'done' is only reachable from 'awaiting_ack', so walk the states
        // the drain actually walks instead of short-cutting pending -> done.
        db.mark_outbox_sending(&[1u8; 16]).unwrap();
        db.mark_outbox_awaiting_ack(&[1u8; 16]).unwrap();
        db.mark_outbox_done(&[1u8; 16]).unwrap();
        assert!(db.due_outbox(i64::MAX).unwrap().is_empty());
    }

    #[test]
    fn claim_sending_is_won_once() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.enqueue_outbox(&row()).unwrap();
        assert!(
            db.mark_outbox_sending(&[1u8; 16]).unwrap(),
            "first claim wins"
        );
        assert!(
            !db.mark_outbox_sending(&[1u8; 16]).unwrap(),
            "second claim on an already-sending row must lose"
        );
    }

    #[test]
    fn peer_online_drains_only_that_peers_due_rows() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.enqueue_outbox(&row_for(1, 7)).unwrap();
        db.enqueue_outbox(&row_for(2, 8)).unwrap();
        assert_eq!(db.due_outbox(i64::MAX).unwrap().len(), 2);
        let for_seven = db.due_outbox_for_peer(&[7u8; 16], i64::MAX).unwrap();
        assert_eq!(for_seven.len(), 1);
        assert_eq!(for_seven[0].id, [1u8; 16]);
    }

    #[test]
    fn manual_retry_resets_backoff_and_attempts() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.enqueue_outbox(&row_for(1, 7)).unwrap();
        // The real state machine only backs a row off from 'sending'.
        assert!(db.mark_outbox_sending(&[1u8; 16]).unwrap());
        db.mark_outbox_failed(&[1u8; 16], 0, 0).unwrap();
        assert!(db.due_outbox(0).unwrap().is_empty());
        assert!(db.retry_outbox_now(&[1u8; 16]).unwrap());
        // retry_outbox_now stamps the REAL clock, so the row is due only at a
        // now after that instant.
        let due = db.due_outbox(i64::MAX).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].attempts, 0);
    }

    #[test]
    fn cancellation_removes_a_queued_row() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.enqueue_outbox(&row_for(1, 7)).unwrap();
        db.delete_outbox(&[1u8; 16]).unwrap();
        assert!(db.due_outbox(i64::MAX).unwrap().is_empty());
        assert!(db.list_outbox_for_peer(&[7u8; 16]).unwrap().is_empty());
    }

    fn row_for(id: u8, peer: u8) -> OutboxRow {
        OutboxRow {
            id: [id; 16],
            payload_id: [id; 16],
            peer_device_id: [peer; 16],
            manifest: vec![1],
            total_bytes: 1,
            attempts: 0,
            next_attempt_at: 0,
            state: "pending".into(),
            created_at: 0,
            updated_at: 0,
        }
    }
}
