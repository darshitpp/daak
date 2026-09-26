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

impl Db {
    pub fn upsert_transfer(&self, t: &TransferRow) -> Result<()> {
        self.conn().execute(
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

    pub fn set_transfer_state(&self, id: &[u8; 16], state: &str) -> Result<()> {
        self.conn().execute(
            "UPDATE transfers SET state = ?2, updated_at = ?3 WHERE transfer_id = ?1",
            rusqlite::params![&id[..], state, now()],
        )?;
        Ok(())
    }

    pub fn add_bytes_done(&self, id: &[u8; 16], delta: u64) -> Result<()> {
        self.conn().execute(
            "UPDATE transfers SET bytes_done = bytes_done + ?2, updated_at = ?3 WHERE transfer_id = ?1",
            rusqlite::params![&id[..], delta as i64, now()],
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
