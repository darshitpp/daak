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
    /// R42p: replace the saved paths of one payload after the platform MOVED
    /// its files out of app storage.
    ///
    /// A move leaves this column naming files that are no longer there, and the
    /// Inbox's open verb reads this column, so without this the row points at a
    /// path that is gone. The WHOLE list is written, not one entry: the caller
    /// just performed the moves and knows the final locations, so a per-entry
    /// replace would only have to agree with it about ordering for no benefit.
    pub fn replace_inbox_paths(&self, id: &[u8; 16], paths: &[String]) -> Result<()> {
        // The SAME encoder the receive path uses for this column. daak-core has
        // no serde_json, and a second hand-rolled encoder here is how the two
        // halves drift on an escape neither one tests.
        let json = crate::engine::json_string_array(paths);
        self.conn().execute(
            "UPDATE inbox_history SET saved_paths = ?2 WHERE id = ?1",
            rusqlite::params![&id[..], json],
        )?;
        Ok(())
    }

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

    // R42p: the platform moved the files, so the row must name the places the
    // files actually are. A stale path here is a Show button that opens nothing.
    #[test]
    fn replace_inbox_paths_rewrites_the_whole_list() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.add_inbox(&InboxRow {
            saved_paths: r#"["/app/downloads/a.jpg"]"#.into(),
            ..row(1, 100)
        })
        .unwrap();

        let moved = vec!["/storage/emulated/0/Download/a.jpg".to_string()];
        db.replace_inbox_paths(&[1u8; 16], &moved).unwrap();

        let got = db.list_inbox().unwrap();
        assert_eq!(
            got[0].saved_paths,
            r#"["/storage/emulated/0/Download/a.jpg"]"#
        );
    }

    // An EMPTY list is a real answer: every file is somewhere this row cannot
    // name. Writing `[]` must be distinguishable from leaving the old value.
    #[test]
    fn replace_inbox_paths_can_record_an_empty_list() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.add_inbox(&InboxRow {
            saved_paths: r#"["/app/downloads/a.jpg"]"#.into(),
            ..row(2, 200)
        })
        .unwrap();

        db.replace_inbox_paths(&[2u8; 16], &Vec::new()).unwrap();
        assert_eq!(db.list_inbox().unwrap()[0].saved_paths, "[]");
    }
}
