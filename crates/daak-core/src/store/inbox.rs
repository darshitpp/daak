use super::Db;
use crate::error::Result;
use rusqlite::OptionalExtension;

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

    /// Applies an inbound payload exactly once. Returns `true` on the first
    /// application. A second delivery of the same `payload_id` writes no row.
    pub fn add_inbox_once(&self, r: &InboxRow) -> Result<bool> {
        let changed = self.conn().execute(
            r#"INSERT INTO inbox_history
                 (id, transfer_id, peer_device_id, kind, item_count, summary, received_at, saved_paths)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
               ON CONFLICT(id) DO NOTHING"#,
            rusqlite::params![
                &r.id[..], &r.transfer_id[..], &r.peer_device_id[..], r.kind,
                r.item_count as i64, r.summary, r.received_at, r.saved_paths,
            ],
        )?;
        Ok(changed == 1)
    }

    /// True when an inbound payload with this `payload_id` is already stored.
    pub fn payload_seen(&self, payload_id: &[u8; 16]) -> Result<bool> {
        let n: i64 = self.conn().query_row(
            "SELECT COUNT(1) FROM inbox_history WHERE id = ?1",
            rusqlite::params![&payload_id[..]],
            |r| r.get(0),
        )?;
        Ok(n > 0)
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
        let conn = self.conn();
        let tx = conn.unchecked_transaction()?;
        // A missing row gives an empty old list. A real SQLite error returns.
        let old_json: Option<String> = tx
            .query_row(
                "SELECT saved_paths FROM inbox_history WHERE id = ?1",
                rusqlite::params![&id[..]],
                |r| r.get(0),
            )
            .optional()?;
        let old = old_json
            .as_deref()
            .map(crate::engine::parse_json_string_array)
            .unwrap_or_default();
        // A list of another length cannot be paired by index. An EMPTY list is
        // a real answer ("no file is nameable") and is always written.
        if !paths.is_empty() && paths.len() != old.len() {
            tracing::warn!(
                payload = %hex::encode(id),
                old = old.len(),
                new = paths.len(),
                "replace_inbox_paths: list length differs; nothing written"
            );
            return Ok(());
        }
        // The SAME encoder the receive path uses for this column. daak-core has
        // no serde_json, and a second hand-rolled encoder here is how the two
        // halves drift on an escape neither one tests.
        let json = crate::engine::json_string_array(paths);
        tx.execute(
            "UPDATE inbox_history SET saved_paths = ?2 WHERE id = ?1",
            rusqlite::params![&id[..], json],
        )?;
        // transfer_id equals the inbox id (record_inbox). The Thread screen
        // reads dest_path, so it must follow the move. An empty list pairs
        // with nothing, so it leaves dest_path alone.
        // First select ALL matching item indexes, then update. An update that
        // ran before a later select could make the select match its own write
        // (a chain or a swap of paths).
        let mut moves: Vec<(u32, &String)> = Vec::new();
        for (from, to) in old.iter().zip(paths.iter()) {
            if from == to {
                continue;
            }
            let mut stmt = tx.prepare(
                "SELECT item_index FROM transfer_items
                   WHERE transfer_id = ?1 AND dest_path = ?2",
            )?;
            let idx = stmt.query_map(rusqlite::params![&id[..], from], |r| r.get::<_, u32>(0))?;
            for i in idx {
                moves.push((i?, to));
            }
        }
        for (index, to) in moves {
            tx.execute(
                "UPDATE transfer_items SET dest_path = ?3
                   WHERE transfer_id = ?1 AND item_index = ?2",
                rusqlite::params![&id[..], index, to],
            )?;
        }
        tx.commit()?;
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

    use crate::store::transfers::{ItemRow, TransferRow};

    fn transfer(id: u8) -> TransferRow {
        TransferRow {
            transfer_id: [id; 16],
            payload_id: [id; 16],
            peer_device_id: [id.wrapping_add(1); 16],
            direction: "in".into(),
            kind: "media".into(),
            state: "done".into(),
            bytes_total: 10,
            bytes_done: 10,
            item_count: 2,
            created_at: 1,
            updated_at: 1,
            manifest: vec![1],
            error: None,
        }
    }

    fn item(id: u8, index: u32, dest: &str) -> ItemRow {
        ItemRow {
            transfer_id: [id; 16],
            item_index: index,
            item_type: "image".into(),
            name: Some(format!("f{index}")),
            mime: None,
            size: Some(1),
            hash: Some([0u8; 32]),
            dest_path: Some(dest.into()),
            state: "done".into(),
        }
    }

    fn dest_of(db: &Db, id: u8, index: u32) -> Option<String> {
        db.list_items(&[id; 16])
            .unwrap()
            .into_iter()
            .find(|i| i.item_index == index)
            .and_then(|i| i.dest_path)
    }

    // The Thread screen reads transfer_items.dest_path, not saved_paths. A
    // platform that moves a file must move BOTH, or Preview opens a path that
    // is gone.
    #[test]
    fn replace_inbox_paths_also_rewrites_the_item_dest_path() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.upsert_transfer(&transfer(1)).unwrap();
        db.upsert_item(&item(1, 0, "/app/a.jpg")).unwrap();
        db.upsert_item(&item(1, 1, "/app/b.pdf")).unwrap();
        db.add_inbox(&InboxRow {
            saved_paths: r#"["/app/a.jpg","/app/b.pdf"]"#.into(),
            ..row(1, 100)
        })
        .unwrap();

        db.replace_inbox_paths(
            &[1u8; 16],
            &["photos:ABC".to_string(), "/app/b.pdf".to_string()],
        )
        .unwrap();

        assert_eq!(dest_of(&db, 1, 0).as_deref(), Some("photos:ABC"));
        // An unchanged path keeps its row.
        assert_eq!(dest_of(&db, 1, 1).as_deref(), Some("/app/b.pdf"));
    }

    // Another transfer can hold the same path string. It must not change.
    #[test]
    fn replace_inbox_paths_leaves_other_transfers_alone() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.upsert_transfer(&transfer(1)).unwrap();
        db.upsert_transfer(&transfer(2)).unwrap();
        db.upsert_item(&item(1, 0, "/app/a.jpg")).unwrap();
        db.upsert_item(&item(2, 0, "/app/a.jpg")).unwrap();
        db.add_inbox(&InboxRow {
            saved_paths: r#"["/app/a.jpg"]"#.into(),
            ..row(1, 100)
        })
        .unwrap();

        db.replace_inbox_paths(&[1u8; 16], &["photos:ABC".to_string()])
            .unwrap();

        assert_eq!(dest_of(&db, 1, 0).as_deref(), Some("photos:ABC"));
        assert_eq!(dest_of(&db, 2, 0).as_deref(), Some("/app/a.jpg"));
    }

    // Two items under one transfer, for the chain, swap, and empty-list tests.
    fn two_item_db(a: &str, b: &str) -> Db {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.upsert_transfer(&transfer(1)).unwrap();
        db.upsert_item(&item(1, 0, a)).unwrap();
        db.upsert_item(&item(1, 1, b)).unwrap();
        db.add_inbox(&InboxRow {
            saved_paths: json_of(&[a, b]),
            ..row(1, 100)
        })
        .unwrap();
        db
    }

    fn json_of(p: &[&str]) -> String {
        let v: Vec<String> = p.iter().map(|s| s.to_string()).collect();
        crate::engine::json_string_array(&v)
    }

    // New path of item 0 equals the old path of item 1. A later update must
    // not match a row that an earlier update wrote.
    #[test]
    fn replace_inbox_paths_handles_a_chain_of_paths() {
        let db = two_item_db("/a", "/b");
        db.replace_inbox_paths(&[1u8; 16], &["/b".to_string(), "/c".to_string()])
            .unwrap();
        assert_eq!(dest_of(&db, 1, 0).as_deref(), Some("/b"));
        assert_eq!(dest_of(&db, 1, 1).as_deref(), Some("/c"));
    }

    #[test]
    fn replace_inbox_paths_handles_a_swap_of_paths() {
        let db = two_item_db("/a", "/b");
        db.replace_inbox_paths(&[1u8; 16], &["/b".to_string(), "/a".to_string()])
            .unwrap();
        assert_eq!(dest_of(&db, 1, 0).as_deref(), Some("/b"));
        assert_eq!(dest_of(&db, 1, 1).as_deref(), Some("/a"));
    }

    // An empty list writes saved_paths and leaves every dest_path alone.
    #[test]
    fn replace_inbox_paths_empty_list_keeps_item_dest_paths() {
        let db = two_item_db("/a", "/b");
        db.replace_inbox_paths(&[1u8; 16], &[]).unwrap();
        assert_eq!(db.list_inbox().unwrap()[0].saved_paths, "[]");
        assert_eq!(dest_of(&db, 1, 0).as_deref(), Some("/a"));
        assert_eq!(dest_of(&db, 1, 1).as_deref(), Some("/b"));
    }

    // A list of the wrong length cannot be paired with the old list by index.
    // Writing it would store a list that names the wrong files.
    #[test]
    fn replace_inbox_paths_refuses_a_list_of_the_wrong_length() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.upsert_transfer(&transfer(1)).unwrap();
        db.upsert_item(&item(1, 0, "/app/a.jpg")).unwrap();
        db.add_inbox(&InboxRow {
            saved_paths: r#"["/app/a.jpg"]"#.into(),
            ..row(1, 100)
        })
        .unwrap();

        db.replace_inbox_paths(
            &[1u8; 16],
            &["/x/a.jpg".to_string(), "/x/b.jpg".to_string()],
        )
        .unwrap();

        assert_eq!(dest_of(&db, 1, 0).as_deref(), Some("/app/a.jpg"));
        assert_eq!(db.list_inbox().unwrap()[0].saved_paths, r#"["/app/a.jpg"]"#);
    }
}

#[cfg(test)]
mod dedupe_tests {
    use super::*;

    fn row(id: u8) -> InboxRow {
        InboxRow {
            id: [id; 16],
            transfer_id: [id; 16],
            peer_device_id: [3u8; 16],
            kind: "text".into(),
            item_count: 1,
            summary: "hi".into(),
            received_at: 1,
            saved_paths: "[]".into(),
        }
    }

    #[test]
    fn duplicate_payload_delivery_is_idempotent() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        assert!(
            db.add_inbox_once(&row(1)).unwrap(),
            "first delivery applies"
        );
        assert!(
            !db.add_inbox_once(&row(1)).unwrap(),
            "second delivery is deduped"
        );
        assert!(db.payload_seen(&[1u8; 16]).unwrap());
    }

    #[test]
    fn replay_guard_persists_and_rejects_the_stored_counter() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        let peer = [4u8; 16];
        let mut w = crate::crypto::replay::ReplayWindow::new(4096);
        assert!(w.accept(100));
        w.persist(&db, &peer, "in").unwrap();

        let mut reloaded = crate::crypto::replay::ReplayWindow::load(&db, &peer, "in").unwrap();
        assert!(
            !reloaded.accept(100),
            "a persisted counter must not be accepted again"
        );
        assert!(reloaded.accept(101));
    }
}
