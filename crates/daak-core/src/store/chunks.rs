use super::Db;
use crate::chunk::ChunkBitmap;
use crate::error::Result;

/// The one DELETE for an item's resume rows, shared by save (which must run it
/// inside its transaction) and clear_bitmap.
const DELETE_ITEM_ROWS: &str = "DELETE FROM chunk_state WHERE transfer_id = ?1 AND item_index = ?2";

impl Db {
    pub fn save_bitmap(&self, t: &[u8; 16], item: u32, b: &ChunkBitmap) -> Result<()> {
        let words = b.words_for_persist();
        let conn = self.conn();
        let tx = conn.unchecked_transaction()?;
        tx.execute(DELETE_ITEM_ROWS, rusqlite::params![&t[..], item as i64])?;
        for (i, w) in words.iter().enumerate() {
            tx.execute(
                "INSERT INTO chunk_state (transfer_id, item_index, word_index, bitmap) VALUES (?1,?2,?3,?4)",
                rusqlite::params![&t[..], item as i64, i as i64, *w as i64],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn load_bitmap(&self, t: &[u8; 16], item: u32, count: u64) -> Result<ChunkBitmap> {
        let mut b = ChunkBitmap::new(count);
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT word_index, bitmap FROM chunk_state
               WHERE transfer_id = ?1 AND item_index = ?2 ORDER BY word_index",
        )?;
        let rows = stmt.query_map(rusqlite::params![&t[..], item as i64], |r| {
            Ok((r.get::<_, i64>(0)? as usize, r.get::<_, i64>(1)? as u64))
        })?;
        for row in rows {
            let (word_index, word) = row?;
            b.set_word(word_index, word);
        }
        Ok(b)
    }

    /// Drop the resume state for one item. Called when the item's bitmap is
    /// complete: a finished item never needs a NACK, so the rows are garbage.
    pub fn clear_bitmap(&self, t: &[u8; 16], item: u32) -> Result<()> {
        self.conn()
            .execute(DELETE_ITEM_ROWS, rusqlite::params![&t[..], item as i64])?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::ChunkBitmap;

    #[test]
    fn bitmap_persists_and_reloads_across_db_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daak.db");
        {
            let db = Db::open(&path).unwrap();
            db.migrate().unwrap();
            let mut b = ChunkBitmap::new(200);
            b.set(0);
            b.set(64);
            b.set(199);
            db.save_bitmap(&[1u8; 16], 0, &b).unwrap();
        }
        let db = Db::open(&path).unwrap();
        db.migrate().unwrap();
        let b = db.load_bitmap(&[1u8; 16], 0, 200).unwrap();
        assert!(b.is_set(0) && b.is_set(64) && b.is_set(199));
        assert!(!b.is_set(1));
    }

    #[test]
    fn clear_bitmap_removes_every_word_for_that_item_only() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        let mut b = ChunkBitmap::new(200);
        for i in 0..200 {
            b.set(i);
        }
        db.save_bitmap(&[1u8; 16], 0, &b).unwrap();
        db.save_bitmap(&[1u8; 16], 1, &b).unwrap();

        let left = |item: i64| -> i64 {
            db.conn()
                .query_row(
                    "SELECT COUNT(*) FROM chunk_state WHERE transfer_id = ?1 AND item_index = ?2",
                    rusqlite::params![&[1u8; 16][..], item],
                    |r| r.get(0),
                )
                .unwrap()
        };
        assert!(left(0) > 0);
        db.clear_bitmap(&[1u8; 16], 0).unwrap();
        assert_eq!(left(0), 0, "completed item must leave no chunk_state rows");
        assert_eq!(left(1), 4, "the other item's rows are untouched");
        assert!(db.load_bitmap(&[1u8; 16], 1, 200).unwrap().is_complete());
    }
}
