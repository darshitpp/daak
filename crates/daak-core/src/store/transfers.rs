use super::Db;
use crate::error::Result;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferRow {
    pub transfer_id: [u8; 16],
    pub payload_id: [u8; 16],
    pub peer_device_id: [u8; 16],
    pub direction: String,
    pub kind: String,
    pub state: String,
    pub bytes_total: u64,
    pub bytes_done: u64,
    pub item_count: u32,
    pub created_at: i64,
    pub updated_at: i64,
    pub manifest: Vec<u8>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemRow {
    pub transfer_id: [u8; 16],
    pub item_index: u32,
    pub item_type: String,
    pub name: Option<String>,
    pub mime: Option<String>,
    pub size: Option<u64>,
    pub hash: Option<[u8; 32]>,
    pub dest_path: Option<String>,
    pub state: String,
}

fn now() -> i64 {
    crate::manifest::now_ms() as i64 / 1000
}

/// The statement `upsert_transfer` runs, factored out so the atomic two-table
/// enqueue can run it inside a transaction.
pub(crate) fn insert_transfer(c: &rusqlite::Connection, t: &TransferRow) -> Result<()> {
    c.execute(
        r#"INSERT INTO transfers
             (transfer_id, payload_id, peer_device_id, direction, kind, state,
              bytes_total, bytes_done, item_count, created_at, updated_at, manifest, error)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
           ON CONFLICT(transfer_id) DO UPDATE SET
             state = excluded.state,
             bytes_total = excluded.bytes_total,
             bytes_done = excluded.bytes_done,
             updated_at = excluded.updated_at,
             error = excluded.error"#,
        rusqlite::params![
            &t.transfer_id[..],
            &t.payload_id[..],
            &t.peer_device_id[..],
            t.direction,
            t.kind,
            t.state,
            t.bytes_total as i64,
            t.bytes_done as i64,
            t.item_count as i64,
            t.created_at,
            t.updated_at,
            t.manifest,
            t.error,
        ],
    )?;
    Ok(())
}

impl Db {
    pub fn upsert_transfer(&self, t: &TransferRow) -> Result<()> {
        insert_transfer(&self.conn(), t)
    }

    pub fn get_transfer(&self, id: &[u8; 16]) -> Result<Option<TransferRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT transfer_id, payload_id, peer_device_id, direction, kind, state,
                    bytes_total, bytes_done, item_count, created_at, updated_at, manifest, error
               FROM transfers WHERE transfer_id = ?1",
        )?;
        let mut rows = stmt.query(rusqlite::params![&id[..]])?;
        match rows.next()? {
            Some(r) => Ok(Some(row_to_transfer(r)?)),
            None => Ok(None),
        }
    }

    pub fn list_transfers_by_state(&self, state: &str) -> Result<Vec<TransferRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT transfer_id, payload_id, peer_device_id, direction, kind, state,
                    bytes_total, bytes_done, item_count, created_at, updated_at, manifest, error
               FROM transfers WHERE state = ?1",
        )?;
        let rows = stmt.query_map(rusqlite::params![state], row_to_transfer)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Transfers newest-first, narrowed by an OPTIONAL state and an OPTIONAL
    /// peer. listTransfers() carries both filters as Option, so ONE static
    /// query with a NULL-means-unset test covers all four combinations and
    /// leaves no room for a built SQL string. `?1 IS NULL OR state = ?1` is
    /// exactly SQLite's own `IS` operator: `state IS ?1` would not do it,
    /// because state is never NULL and so would only ever match a NULL state.
    /// ponytail: ORDER BY is created_at/transfer_id rather than updated_at so
    /// the order is a stable tiebreak; the UI re-sorts on updated_at itself.
    pub fn list_transfers(
        &self,
        state: Option<&str>,
        peer_device_id: Option<&[u8; 16]>,
    ) -> Result<Vec<TransferRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT transfer_id, payload_id, peer_device_id, direction, kind, state,
                    bytes_total, bytes_done, item_count, created_at, updated_at, manifest, error
               FROM transfers
              WHERE (?1 IS NULL OR state = ?1)
                AND (?2 IS NULL OR peer_device_id = ?2)
              ORDER BY created_at DESC, transfer_id",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![state, peer_device_id.map(<[u8; 16]>::as_slice)],
            row_to_transfer,
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // One page holds the transfers of one peer, newest first.
    // After holds the position of the last row of the prior page.
    // The tiebreak matches list_transfers, so no row repeats on 2 pages.
    pub fn list_peer_transfers_page(
        &self,
        peer: &[u8; 16],
        after: Option<(i64, [u8; 16])>,
        limit: u32,
    ) -> Result<Vec<TransferRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT transfer_id, payload_id, peer_device_id, direction, kind, state, bytes_total, bytes_done, item_count, created_at, updated_at, manifest, error FROM transfers WHERE peer_device_id = ?1 AND (?2 IS NULL OR created_at < ?2 OR (created_at = ?2 AND transfer_id > ?3)) ORDER BY created_at DESC, transfer_id LIMIT ?4",
        )?;
        let (at, id) = match after {
            Some((at, id)) => (Some(at), Some(id.to_vec())),
            None => (None, None),
        };
        let rows = stmt.query_map(
            rusqlite::params![&peer[..], at, id, limit as i64],
            row_to_transfer,
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn set_transfer_state(&self, id: &[u8; 16], state: &str) -> Result<()> {
        self.conn().execute(
            "UPDATE transfers SET state = ?2, updated_at = ?3 WHERE transfer_id = ?1",
            rusqlite::params![&id[..], state, now()],
        )?;
        Ok(())
    }

    // Set the state only when the row is NOT already 'canceled'. A drain in
    // flight lost the outbox guard to a cancel or a revoke, but its transfers
    // write can still land after the cancel's: without this guard it relabels a
    // canceled share 'failed' (or 'paused'). True only when the write matched.
    pub fn set_transfer_state_unless_canceled(&self, id: &[u8; 16], state: &str) -> Result<bool> {
        let n = self.conn().execute(
            "UPDATE transfers SET state = ?2, updated_at = ?3
              WHERE transfer_id = ?1 AND state != 'canceled'",
            rusqlite::params![&id[..], state, now()],
        )?;
        Ok(n > 0)
    }

    // Close the open outbound transfers of one peer. The pairing is revoked,
    // so these sends can never move: the outbox rows are gone. The rows stay
    // as history and read canceled with one l. Final rows, inbound rows, and
    // rows of other peers do not change. Returns the changed row count.
    pub fn cancel_outbound_transfers_for_peer(&self, peer: &[u8; 16]) -> Result<usize> {
        let n = self.conn().execute(
            "UPDATE transfers SET state = 'canceled', error = 'unpaired', updated_at = ?2
              WHERE peer_device_id = ?1 AND direction = 'out'
                AND state IN ('queued','active','paused','awaiting_ack')",
            rusqlite::params![&peer[..], now()],
        )?;
        Ok(n)
    }

    pub fn add_bytes_done(&self, id: &[u8; 16], delta: u64) -> Result<()> {
        self.conn().execute(
            "UPDATE transfers SET bytes_done = bytes_done + ?2, updated_at = ?3 WHERE transfer_id = ?1",
            rusqlite::params![&id[..], delta as i64, now()],
        )?;
        Ok(())
    }

    pub fn set_bytes_done(&self, id: &[u8; 16], value: u64) -> Result<()> {
        self.conn().execute(
            "UPDATE transfers SET bytes_done = ?2, updated_at = ?3 WHERE transfer_id = ?1",
            rusqlite::params![&id[..], value as i64, now()],
        )?;
        Ok(())
    }

    /// Crash recovery: a transfer left active (mid-receive) or awaiting_ack
    /// (mid-send, awaiting the peer Ack) on startup is reset to queued so the
    /// outbox can re-send it. queued is the engine re-queue sentinel (spec 4.2
    /// transfer states: queued|active|paused|awaiting_ack|done|failed|canceled).
    pub fn reset_inflight_transfers(&self) -> Result<usize> {
        let n = self.conn().execute(
            "UPDATE transfers SET state = 'queued' WHERE state IN ('active','awaiting_ack','paused')",
            [],
        )?;
        Ok(n)
    }

    pub fn upsert_item(&self, i: &ItemRow) -> Result<()> {
        self.conn().execute(
            r#"INSERT INTO transfer_items
                 (transfer_id, item_index, type, name, mime, size, hash, dest_path, state)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
               ON CONFLICT(transfer_id, item_index) DO UPDATE SET
                 state = excluded.state, dest_path = excluded.dest_path"#,
            rusqlite::params![
                &i.transfer_id[..],
                i.item_index as i64,
                i.item_type,
                i.name,
                i.mime,
                i.size.map(|v| v as i64),
                i.hash.map(|h| h.to_vec()),
                i.dest_path,
                i.state,
            ],
        )?;
        Ok(())
    }

    pub fn list_items(&self, transfer_id: &[u8; 16]) -> Result<Vec<ItemRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT transfer_id, item_index, type, name, mime, size, hash, dest_path, state
               FROM transfer_items WHERE transfer_id = ?1 ORDER BY item_index",
        )?;
        let rows = stmt.query_map(rusqlite::params![&transfer_id[..]], row_to_item)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn set_item_state(&self, t: &[u8; 16], idx: u32, state: &str) -> Result<()> {
        self.conn().execute(
            "UPDATE transfer_items SET state = ?3 WHERE transfer_id = ?1 AND item_index = ?2",
            rusqlite::params![&t[..], idx as i64, state],
        )?;
        Ok(())
    }

    /// Drop an item row for good.
    ///
    /// `delete_quarantined_item` is a user decision to discard a held-back file
    /// entirely, so the row that described it has to go with it: leaving a
    /// `quarantined` row naming a file that no longer exists is a transfer that
    /// can never settle and an item the UI would offer to check again forever.
    ///
    /// The caller checks the row exists first (require_item), so a missing row
    /// is not silently reported as a successful delete here.
    pub fn delete_item(&self, t: &[u8; 16], idx: u32) -> Result<()> {
        self.conn().execute(
            "DELETE FROM transfer_items WHERE transfer_id = ?1 AND item_index = ?2",
            rusqlite::params![&t[..], idx as i64],
        )?;
        Ok(())
    }

    /// Rewrite a transfer's item_count and error text together.
    ///
    /// Both are DERIVED facts about the item rows that still exist, so they are
    /// written in one statement: computing the new count, then writing the count
    /// and the error separately, would let a reader see a count from one set of
    /// rows and an error naming a different set.
    pub fn update_transfer_summary(
        &self,
        id: &[u8; 16],
        item_count: u32,
        error: Option<&str>,
    ) -> Result<()> {
        self.conn().execute(
            "UPDATE transfers SET item_count = ?2, error = ?3, updated_at = ?4 WHERE transfer_id = ?1",
            rusqlite::params![&id[..], item_count as i64, error, now()],
        )?;
        Ok(())
    }

    /// R-T12-7: the UPDATE above matches zero rows for an unknown
    /// (transfer_id, item_index), so a caller cannot tell "re-armed" from
    /// "no such item". This is the read that makes the difference visible.
    pub fn get_item(&self, transfer_id: &[u8; 16], item_index: u32) -> Result<Option<ItemRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT transfer_id, item_index, type, name, mime, size, hash, dest_path, state
               FROM transfer_items WHERE transfer_id = ?1 AND item_index = ?2",
        )?;
        let mut rows = stmt.query(rusqlite::params![&transfer_id[..], item_index as i64])?;
        match rows.next()? {
            Some(r) => Ok(Some(row_to_item(r)?)),
            None => Ok(None),
        }
    }
}

fn row_to_transfer(r: &rusqlite::Row<'_>) -> rusqlite::Result<TransferRow> {
    let id: Vec<u8> = r.get(0)?;
    let pid: Vec<u8> = r.get(1)?;
    let peer: Vec<u8> = r.get(2)?;
    let a16 = |v: Vec<u8>| -> rusqlite::Result<[u8; 16]> {
        v.try_into().map_err(|_| rusqlite::Error::InvalidQuery)
    };
    Ok(TransferRow {
        transfer_id: a16(id)?,
        payload_id: a16(pid)?,
        peer_device_id: a16(peer)?,
        direction: r.get(3)?,
        kind: r.get(4)?,
        state: r.get(5)?,
        bytes_total: r.get::<_, i64>(6)? as u64,
        bytes_done: r.get::<_, i64>(7)? as u64,
        item_count: r.get::<_, i64>(8)? as u32,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
        manifest: r.get(11)?,
        error: r.get(12)?,
    })
}

fn row_to_item(r: &rusqlite::Row<'_>) -> rusqlite::Result<ItemRow> {
    let t: Vec<u8> = r.get(0)?;
    let hash: Option<Vec<u8>> = r.get(6)?;
    Ok(ItemRow {
        transfer_id: t.try_into().map_err(|_| rusqlite::Error::InvalidQuery)?,
        item_index: r.get::<_, i64>(1)? as u32,
        item_type: r.get(2)?,
        name: r.get(3)?,
        mime: r.get(4)?,
        size: r.get::<_, Option<i64>>(5)?.map(|v| v as u64),
        hash: hash
            .map(|h| h.try_into().map_err(|_| rusqlite::Error::InvalidQuery))
            .transpose()?,
        dest_path: r.get(7)?,
        state: r.get(8)?,
    })
}
#[cfg(test)]
mod tests {
    use super::*;

    fn row() -> TransferRow {
        TransferRow {
            transfer_id: [1u8; 16],
            payload_id: [2u8; 16],
            peer_device_id: [3u8; 16],
            direction: "out".into(),
            kind: "media".into(),
            state: "queued".into(),
            bytes_total: 1000,
            bytes_done: 0,
            item_count: 1,
            created_at: 1,
            updated_at: 1,
            manifest: vec![1, 2, 3],
            error: None,
        }
    }

    #[test]
    fn transfer_state_and_progress_roundtrip() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.upsert_transfer(&row()).unwrap();
        db.set_transfer_state(&[1u8; 16], "active").unwrap();
        db.add_bytes_done(&[1u8; 16], 250).unwrap();

        let got = db.get_transfer(&[1u8; 16]).unwrap().unwrap();
        assert_eq!(got.state, "active");
        assert_eq!(got.bytes_done, 250);
        assert_eq!(db.list_transfers_by_state("active").unwrap().len(), 1);
    }

    #[test]
    fn reset_inflight_transfers_moves_active_to_queued() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.upsert_transfer(&row()).unwrap();
        db.set_transfer_state(&[1u8; 16], "active").unwrap();
        let n = db.reset_inflight_transfers().unwrap();
        assert_eq!(n, 1);
        assert_eq!(
            db.get_transfer(&[1u8; 16]).unwrap().unwrap().state,
            "queued"
        );
    }

    // list_transfers feeds listTransfers(), whose filter is optional on both
    // axes. Four static branches cover the four combinations; the None/None
    // one is the list-everything case a UI shows before any filter is set.
    fn seeded() -> Db {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.upsert_transfer(&row()).unwrap();
        let mut other = row();
        other.transfer_id = [9u8; 16];
        other.payload_id = [10u8; 16];
        other.peer_device_id = [11u8; 16];
        other.state = "done".into();
        db.upsert_transfer(&other).unwrap();
        db
    }

    #[test]
    fn list_transfers_filters_by_state_and_peer_and_lists_everything() {
        let db = seeded();
        assert_eq!(db.list_transfers(None, None).unwrap().len(), 2);
        assert_eq!(db.list_transfers(Some("queued"), None).unwrap().len(), 1);
        assert_eq!(
            db.list_transfers(Some("queued"), Some(&[3u8; 16])).unwrap()[0].transfer_id,
            [1u8; 16]
        );
        // Both filters must apply AND, not OR: the peer of the done row is not
        // the peer of the queued one, so this matches nothing.
        assert!(db
            .list_transfers(Some("done"), Some(&[3u8; 16]))
            .unwrap()
            .is_empty());
        assert_eq!(db.list_transfers(None, Some(&[11u8; 16])).unwrap().len(), 1);
        assert!(db.list_transfers(Some("nope"), None).unwrap().is_empty());
    }

    fn put(db: &Db, id: u8, peer: u8, created_at: i64) {
        let mut t = row();
        t.transfer_id = [id; 16];
        t.payload_id = [id; 16];
        t.peer_device_id = [peer; 16];
        t.created_at = created_at;
        t.updated_at = created_at;
        db.upsert_transfer(&t).unwrap();
    }

    #[test]
    fn peer_page_is_newest_first_and_ignores_other_peers() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        put(&db, 1, 3, 10);
        put(&db, 2, 3, 30);
        put(&db, 3, 3, 20);
        put(&db, 4, 7, 99);
        let page = db.list_peer_transfers_page(&[3u8; 16], None, 10).unwrap();
        let ids: Vec<u8> = page.iter().map(|t| t.transfer_id[0]).collect();
        assert_eq!(ids, vec![2, 3, 1]);
    }

    #[test]
    fn peer_pages_join_without_gap_or_overlap_on_equal_timestamps() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        put(&db, 1, 3, 10);
        put(&db, 2, 3, 20);
        put(&db, 3, 3, 20);
        put(&db, 4, 3, 20);
        put(&db, 5, 3, 30);
        let first = db.list_peer_transfers_page(&[3u8; 16], None, 2).unwrap();
        let last = first.last().unwrap();
        let second = db
            .list_peer_transfers_page(&[3u8; 16], Some((last.created_at, last.transfer_id)), 2)
            .unwrap();
        let last = second.last().unwrap();
        let third = db
            .list_peer_transfers_page(&[3u8; 16], Some((last.created_at, last.transfer_id)), 2)
            .unwrap();
        let ids: Vec<u8> = first
            .iter()
            .chain(second.iter())
            .chain(third.iter())
            .map(|t| t.transfer_id[0])
            .collect();
        assert_eq!(ids, vec![5, 2, 3, 4, 1]);
    }

    #[test]
    fn peer_page_with_zero_limit_is_empty() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        put(&db, 1, 3, 10);
        assert!(db
            .list_peer_transfers_page(&[3u8; 16], None, 0)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn cancel_outbound_transfers_for_peer_closes_only_the_open_outbound_rows_of_that_peer() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        let put = |id: u8, peer: u8, direction: &str, state: &str| {
            let mut r = row();
            r.transfer_id = [id; 16];
            r.payload_id = [id.wrapping_add(100); 16];
            r.peer_device_id = [peer; 16];
            r.direction = direction.into();
            r.state = state.into();
            db.upsert_transfer(&r).unwrap();
        };
        put(1, 3, "out", "queued");
        put(2, 3, "out", "active");
        put(3, 3, "out", "paused");
        put(4, 3, "out", "awaiting_ack");
        put(5, 3, "out", "done");
        put(6, 3, "out", "failed");
        put(7, 3, "in", "queued");
        put(8, 9, "out", "queued");

        let n = db.cancel_outbound_transfers_for_peer(&[3u8; 16]).unwrap();
        assert_eq!(n, 4, "queued, active, paused, and awaiting_ack");

        for id in 1u8..=4 {
            let r = db.get_transfer(&[id; 16]).unwrap().unwrap();
            assert_eq!(r.state, "canceled", "row {id}");
            assert_eq!(r.error.as_deref(), Some("unpaired"), "row {id}");
            assert!(r.updated_at > 1, "row {id} must get a new updated_at");
        }
        for (id, state) in [(5u8, "done"), (6, "failed"), (7, "queued"), (8, "queued")] {
            let r = db.get_transfer(&[id; 16]).unwrap().unwrap();
            assert_eq!(r.state, state, "row {id} must not change");
            assert_eq!(r.error, None, "row {id} must not change");
            assert_eq!(r.updated_at, 1, "row {id} must not change");
        }
        assert_eq!(
            db.cancel_outbound_transfers_for_peer(&[3u8; 16]).unwrap(),
            0
        );
    }

    // A drain in flight can settle a transfer after a cancel or a revoke
    // landed. The guarded terminal write and the revoke write must then leave
    // the finished row alone. Write the state first, so no thread timing is
    // needed.
    #[test]
    fn a_cancel_and_a_revoke_never_relabel_a_finished_transfer() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        let mut canceled = row();
        canceled.transfer_id = [1u8; 16];
        canceled.payload_id = [2u8; 16];
        canceled.state = "canceled".into();
        db.upsert_transfer(&canceled).unwrap();
        let mut done = row();
        done.transfer_id = [4u8; 16];
        done.payload_id = [5u8; 16];
        done.state = "done".into();
        db.upsert_transfer(&done).unwrap();

        // The drain's guarded write refuses a canceled row.
        assert!(!db
            .set_transfer_state_unless_canceled(&[1u8; 16], "failed")
            .unwrap());
        assert_eq!(
            db.get_transfer(&[1u8; 16]).unwrap().unwrap().state,
            "canceled"
        );

        // The revoke write closes open outbound rows only, so a done row stays.
        assert_eq!(
            db.cancel_outbound_transfers_for_peer(&[3u8; 16]).unwrap(),
            0
        );
        assert_eq!(db.get_transfer(&[4u8; 16]).unwrap().unwrap().state, "done");
    }
}

#[cfg(test)]
mod item_tests {
    use super::*;

    #[test]
    fn item_row_roundtrips_hash_size_and_state() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        // Parent transfer must exist before its items (FK cascade).
        db.upsert_transfer(&TransferRow {
            transfer_id: [4u8; 16],
            payload_id: [5u8; 16],
            peer_device_id: [6u8; 16],
            direction: "in".into(),
            kind: "media".into(),
            state: "done".into(),
            bytes_total: 1234,
            bytes_done: 1234,
            item_count: 1,
            created_at: 1,
            updated_at: 1,
            manifest: vec![1, 2, 3],
            error: None,
        })
        .unwrap();
        let item = ItemRow {
            transfer_id: [4u8; 16],
            item_index: 7,
            item_type: "document".into(),
            name: Some("a.bin".into()),
            mime: Some("application/octet-stream".into()),
            size: Some(1234),
            hash: Some([9u8; 32]),
            dest_path: Some("/tmp/out/a.bin".into()),
            state: "receiving".into(),
        };
        db.upsert_item(&item).unwrap();
        let got = db.list_items(&[4u8; 16]).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].item_type, "document");
        assert_eq!(got[0].name.as_deref(), Some("a.bin"));
        assert_eq!(got[0].size, Some(1234));
        assert_eq!(got[0].hash, Some([9u8; 32]));
        assert_eq!(got[0].dest_path.as_deref(), Some("/tmp/out/a.bin"));
        assert_eq!(got[0].state, "receiving");

        db.set_item_state(&[4u8; 16], 7, "done").unwrap();
        assert_eq!(db.list_items(&[4u8; 16]).unwrap()[0].state, "done");
    }
}
