use super::Db;
use crate::error::Result;

impl Db {
    pub fn get_setting(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query(rusqlite::params![key])?;
        match rows.next()? {
            Some(r) => Ok(Some(r.get(0)?)),
            None => Ok(None),
        }
    }

    pub fn set_setting(&self, key: &str, value: &[u8]) -> Result<()> {
        self.conn().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )?;
        Ok(())
    }

    pub fn delete_setting(&self, key: &str) -> Result<()> {
        self.conn().execute(
            "DELETE FROM settings WHERE key = ?1",
            rusqlite::params![key],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_round_trip_and_delete() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        assert!(db.get_setting("theme").unwrap().is_none());

        db.set_setting("theme", b"dark").unwrap();
        assert_eq!(db.get_setting("theme").unwrap().unwrap(), b"dark");

        db.set_setting("theme", b"light").unwrap();
        assert_eq!(db.get_setting("theme").unwrap().unwrap(), b"light");

        // A zero-length blob round-trips as an empty vec, not as None.
        db.set_setting("empty", b"").unwrap();
        assert_eq!(db.get_setting("empty").unwrap().unwrap(), b"");

        // Deleting a key that was never set is a silent no-op, like the rest
        // of the store (clear_bitmap, revoke_pairing).
        db.delete_setting("nope").unwrap();

        db.delete_setting("theme").unwrap();
        assert!(db.get_setting("theme").unwrap().is_none());
    }
}
