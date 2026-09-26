use super::Db;
use crate::error::Result;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboxRow {
    pub id: [u8; 16],
    pub transfer_id: [u8; 16],
    pub peer_device_id: [u8; 16],
    pub kind: String,
    pub item_count: u32,
    pub summary: String,
    pub received_at: i64,
    pub saved_paths: String,
}

impl Db {
    pub fn add_inbox(&self, r: &InboxRow) -> Result<()> {
        self.conn().execute(
            r#"INSERT INTO inbox_history
                 (id, transfer_id, peer_device_id, kind, item_count, summary, received_at, saved_paths)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8)"#,
            rusqlite::params![
                &r.id[..], &r.transfer_id[..], &r.peer_device_id[..], r.kind,
                r.item_count as i64, r.summary, r.received_at, r.saved_paths,
            ],
        )?;
        Ok(())
    }

    /// Every received payload, newest first. listInbox() is the only reader;
    /// ordering is fixed HERE so the FFI and the daemon cannot disagree.
    pub fn list_inbox(&self) -> Result<Vec<InboxRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, transfer_id, peer_device_id, kind, item_count, summary, received_at, saved_paths
               FROM inbox_history ORDER BY received_at DESC, id DESC",
        )?;
        let rows = stmt.query_map([], row_to_inbox)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

fn row_to_inbox(r: &rusqlite::Row<'_>) -> rusqlite::Result<InboxRow> {
    let a16 = |v: Vec<u8>| -> rusqlite::Result<[u8; 16]> {
        v.try_into().map_err(|_| rusqlite::Error::InvalidQuery)
    };
    Ok(InboxRow {
        id: a16(r.get(0)?)?,
        transfer_id: a16(r.get(1)?)?,
        peer_device_id: a16(r.get(2)?)?,
        kind: r.get(3)?,
        item_count: r.get::<_, i64>(4)? as u32,
        summary: r.get(5)?,
        received_at: r.get(6)?,
        saved_paths: r.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: u8, at: i64) -> InboxRow {
        InboxRow {
            id: [id; 16],
            transfer_id: [id; 16],
            peer_device_id: [id.wrapping_add(1); 16],
            kind: "text".into(),
            item_count: 1,
            summary: format!("payload {id}"),
            received_at: at,
            saved_paths: "[]".into(),
        }
    }

    #[test]
    fn list_inbox_returns_every_row_newest_first_with_its_ids() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        assert!(db.list_inbox().unwrap().is_empty());
        db.add_inbox(&row(1, 100)).unwrap();
        db.add_inbox(&row(2, 200)).unwrap();

        let got = db.list_inbox().unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].id, [2u8; 16]);
        assert_eq!(got[0].summary, "payload 2");
        assert_eq!(got[1].id, [1u8; 16]);
    }
}
