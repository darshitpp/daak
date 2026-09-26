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
    let base = 15i64.saturating_mul(1i64 << attempts.min(6));
    (base + jitter as i64).min(600)
}

impl Db {
    pub fn enqueue_outbox(&self, o: &OutboxRow) -> Result<()> {
        self.conn().execute(
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

    pub fn due_outbox(&self, now: i64) -> Result<Vec<OutboxRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, payload_id, peer_device_id, manifest, total_bytes, attempts,
                    next_attempt_at, state, created_at, updated_at
               FROM outbox WHERE state = 'pending' AND next_attempt_at <= ?1
               ORDER BY created_at",
        )?;
        let rows = stmt.query_map(rusqlite::params![now], |r| {
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
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
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

    pub fn mark_outbox_failed(&self, id: &[u8; 16], now: i64, jitter: u64) -> Result<()> {
        let conn = self.conn();
        let attempts: u32 = conn
            .query_row(
                "SELECT attempts FROM outbox WHERE id = ?1",
                rusqlite::params![&id[..]],
                |r| r.get::<_, i64>(0),
            )
            .map(|v| v as u32)?;
        let next = now + backoff_delay(attempts + 1, jitter);
        conn.execute(
            "UPDATE outbox SET state = 'pending', attempts = attempts + 1, next_attempt_at = ?2, updated_at = ?3 WHERE id = ?1",
            rusqlite::params![&id[..], next, now],
        )?;
        Ok(())
    }

    pub fn mark_outbox_done(&self, id: &[u8; 16]) -> Result<()> {
        self.conn().execute(
            "UPDATE outbox SET state = 'done', updated_at = ?2 WHERE id = ?1",
            rusqlite::params![&id[..], crate::manifest::now_ms() as i64 / 1000],
        )?;
        Ok(())
    }
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
}
