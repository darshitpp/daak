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

/// The shortest time in seconds since the last attempt on a row before
/// `wake_outbox_for_peer` makes that row due.
pub const WAKE_MIN_IDLE_SECS: i64 = 30;

/// The retry wait in seconds, with a 10-minute cap. The jitter is
/// caller-supplied seconds.
pub fn backoff_delay(attempts: u32, jitter: u64) -> i64 {
    backoff_delay_with(attempts, jitter, 600)
}

/// The same schedule as `backoff_delay`, with a caller-supplied cap in
/// seconds. The drain uses a higher cap when the device is in battery-saver
/// mode. `backoff_delay(attempts, jitter)` is exactly
/// `backoff_delay_with(attempts, jitter, 600)`.
///
/// `attempts` is the number of the failed attempt, from 1. The jitter adds at
/// most half of the step, so a 2 s step never waits more than 3 s.
pub fn backoff_delay_with(attempts: u32, jitter: u64, cap_secs: i64) -> i64 {
    // The user schedule: fast first, then slower. 100 attempts take about 37
    // minutes of waiting, plus the dial time.
    let step: i64 = match attempts {
        0..=5 => 2,
        6..=10 => 3,
        11..=15 => 5,
        16..=20 => 10,
        21..=39 => 15,
        _ => 30,
    };
    // Bound the jitter before the cast. A u64 above i64::MAX casts to a
    // negative value.
    let jitter = jitter.min(step as u64 / 2) as i64;
    (step + jitter).min(cap_secs)
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

    /// Make the pending rows of ONE peer due now. The engine calls this once
    /// for each offline-to-online change of the peer. The idle guard skips a
    /// row that the drain tried less than `WAKE_MIN_IDLE_SECS` ago. It limits
    /// a forged or flapping signal. This method does not change `attempts`.
    /// It returns the number of rows changed.
    pub fn wake_outbox_for_peer(&self, peer: &[u8; 16], now: i64) -> Result<usize> {
        let n = self.conn().execute(
            "UPDATE outbox SET next_attempt_at = ?2
             WHERE state = 'pending' AND peer_device_id = ?1
               AND next_attempt_at > ?2 AND updated_at <= ?2 - ?3",
            rusqlite::params![&peer[..], now, WAKE_MIN_IDLE_SECS],
        )?;
        Ok(n)
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
    /// The payload ids of every outbox row that is not delivered. Their staged
    /// files must survive the startup sweep: a `failed` row can still be retried.
    pub fn live_outbox_payload_ids(&self) -> Result<Vec<[u8; 16]>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT payload_id FROM outbox WHERE state != 'done'")?;
        let rows = stmt.query_map([], |r| r.get::<_, Vec<u8>>(0))?;
        let mut out = Vec::new();
        for r in rows {
            if let Ok(id) = <[u8; 16]>::try_from(r?.as_slice()) {
                out.push(id);
            }
        }
        Ok(out)
    }

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
        tracing::warn!(
            "outbox row {} failed permanently: {error}",
            crate::diag::short_id(id)
        );
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

    /// Claim a failed row for a cancel. True only for the caller that moved
    /// the row from `failed` to `canceled`. A retry that re-armed the row
    /// first wins, so the cancel must not delete its staged files. No query
    /// selects `canceled`, so the worker and a retry leave the row alone.
    pub fn cancel_failed_outbox(&self, id: &[u8; 16]) -> Result<bool> {
        let n = self.conn().execute(
            "UPDATE outbox SET state = 'canceled', updated_at = ?2
             WHERE id = ?1 AND state = 'failed'",
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
    /// -> duplicate delivery). A canceled pending row lives in "failed", so
    /// cancel then retry is still the intended undo path. A canceled failed
    /// row lives in "canceled" (F5). Its staged files are gone, so it is not
    /// re-armed.
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

    // F5: the cancel of a failed row claims it with one guarded UPDATE. A row
    // that a retry re-armed first is not claimed, so its staged files stay.
    #[test]
    fn cancel_failed_outbox_claims_only_a_failed_row_once() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        let mut r = row();
        r.state = "failed".into();
        db.enqueue_outbox(&r).unwrap();
        assert!(db.retry_outbox_now(&r.id).unwrap());
        assert!(
            !db.cancel_failed_outbox(&r.id).unwrap(),
            "a re-armed row is not claimed"
        );
        assert_eq!(db.get_outbox(&r.id).unwrap().unwrap().state, "pending");
        assert!(db.mark_outbox_sending(&r.id).unwrap());
        assert!(db.mark_outbox_terminal_failed(&r.id, "gave up").unwrap());
        assert!(db.cancel_failed_outbox(&r.id).unwrap());
        assert!(
            !db.cancel_failed_outbox(&r.id).unwrap(),
            "only one caller claims the row"
        );
        assert_eq!(db.get_outbox(&r.id).unwrap().unwrap().state, "canceled");
        assert!(
            !db.retry_outbox_now(&r.id).unwrap(),
            "a canceled row is not re-armed"
        );
    }

    #[test]
    fn live_outbox_payload_ids_skips_delivered_rows() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        let mut live = row();
        live.state = "failed".into();
        db.enqueue_outbox(&live).unwrap();
        let mut done = row_for(9, 3);
        done.payload_id = [8u8; 16];
        done.state = "done".into();
        db.enqueue_outbox(&done).unwrap();
        assert_eq!(db.live_outbox_payload_ids().unwrap(), vec![[2u8; 16]]);
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

        // First failure at now=100: backoff_delay(attempts+1 = 1, 0) = 2,
        // so next_attempt_at = 102.
        assert!(db.mark_outbox_sending(&[1u8; 16]).unwrap());
        db.mark_outbox_failed(&[1u8; 16], 100, 0).unwrap();
        assert_eq!(
            db.due_outbox(100).unwrap().len(),
            0,
            "not due before backoff elapses"
        );
        assert_eq!(db.due_outbox(101).unwrap().len(), 0);
        assert_eq!(
            db.due_outbox(102).unwrap().len(),
            1,
            "due once backoff elapses"
        );
        assert_eq!(db.due_outbox(999).unwrap().len(), 1);

        assert!(backoff_delay(1, 0) <= backoff_delay(2, 0));
        assert!(backoff_delay(9, 0) <= 600, "backoff must cap at 10 minutes");
    }

    #[test]
    fn the_wait_follows_the_table() {
        let table = [
            (1, 2),
            (5, 2),
            (6, 3),
            (10, 3),
            (11, 5),
            (15, 5),
            (16, 10),
            (20, 10),
            (21, 15),
            (39, 15),
            (40, 30),
            (100, 30),
        ];
        for (n, want) in table {
            assert_eq!(backoff_delay_with(n, 0, 600), want, "attempt {n}");
        }
    }

    #[test]
    fn the_jitter_is_at_most_half_of_the_step() {
        assert_eq!(backoff_delay_with(1, 5, 600), 3);
        assert_eq!(backoff_delay_with(1, 1, 600), 3);
        assert_eq!(backoff_delay_with(40, 5, 600), 35);
        assert_eq!(backoff_delay_with(40, 100, 600), 45);
    }

    #[test]
    fn a_huge_jitter_does_not_make_the_wait_negative_or_shorter_than_the_step() {
        // u64::MAX cast to i64 is -1. The bound must apply before the cast.
        assert_eq!(backoff_delay_with(1, u64::MAX, 600), 3);
        assert_eq!(backoff_delay_with(40, u64::MAX, 600), 45);
        assert_eq!(backoff_delay_with(40, 1 << 63, 600), 45);
    }

    #[test]
    fn the_cap_still_applies() {
        assert_eq!(backoff_delay_with(40, 0, 20), 20);
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

    fn backed_off(id: u8, peer: u8, attempts: u32, updated_at: i64) -> OutboxRow {
        let mut r = row_for(id, peer);
        r.attempts = attempts;
        r.next_attempt_at = 600;
        r.updated_at = updated_at;
        r
    }

    #[test]
    fn wake_makes_a_backed_off_row_due() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.enqueue_outbox(&backed_off(1, 3, 5, 7)).unwrap();
        assert!(db.due_outbox_for_peer(&[3u8; 16], 100).unwrap().is_empty());
        assert_eq!(db.wake_outbox_for_peer(&[3u8; 16], 100).unwrap(), 1);
        let due = db.due_outbox_for_peer(&[3u8; 16], 100).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].attempts, 5);
        assert_eq!(due[0].updated_at, 7);
    }

    #[test]
    fn wake_leaves_other_states_alone() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        for id in 1..=4u8 {
            db.enqueue_outbox(&row_for(id, 3)).unwrap();
        }
        // 1: sending. 2: awaiting_ack. 3: done. 4: terminal failed.
        assert!(db.mark_outbox_sending(&[1u8; 16]).unwrap());
        for id in [2u8, 3] {
            assert!(db.mark_outbox_sending(&[id; 16]).unwrap());
            assert!(db.mark_outbox_awaiting_ack(&[id; 16]).unwrap());
        }
        assert!(db.mark_outbox_done(&[3u8; 16]).unwrap());
        assert!(db.mark_outbox_terminal_failed(&[4u8; 16], "test").unwrap());
        // The state walk stamps the real clock. Push the fields back.
        db.conn()
            .execute(
                "UPDATE outbox SET next_attempt_at = 600, updated_at = 0",
                [],
            )
            .unwrap();
        assert_eq!(db.wake_outbox_for_peer(&[3u8; 16], 100).unwrap(), 0);
        for r in db.list_outbox_for_peer(&[3u8; 16]).unwrap() {
            assert_eq!(r.next_attempt_at, 600, "state {}", r.state);
        }
    }

    #[test]
    fn wake_touches_only_the_named_peer() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.enqueue_outbox(&backed_off(1, 3, 0, 0)).unwrap();
        db.enqueue_outbox(&backed_off(2, 4, 0, 0)).unwrap();
        assert_eq!(db.wake_outbox_for_peer(&[3u8; 16], 100).unwrap(), 1);
        let other = db.get_outbox(&[2u8; 16]).unwrap().unwrap();
        assert_eq!(other.next_attempt_at, 600);
    }

    #[test]
    fn wake_skips_a_row_tried_less_than_30_s_ago() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.enqueue_outbox(&backed_off(1, 3, 1, 90)).unwrap();
        assert_eq!(db.wake_outbox_for_peer(&[3u8; 16], 100).unwrap(), 0);
        assert_eq!(db.wake_outbox_for_peer(&[3u8; 16], 120).unwrap(), 1);
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
