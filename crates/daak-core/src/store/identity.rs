use crate::error::Result;

use super::Db;

impl Db {
    pub fn save_identity(
        &self,
        device_id: &[u8; 16],
        ed25519_pub: &[u8; 32],
        x25519_pub: &[u8; 32],
        display_name: &str,
    ) -> Result<()> {
        self.conn().execute(
            r#"INSERT INTO identity (id, device_id, ed25519_pub, x25519_pub, display_name, created_at)
               VALUES (1, ?1, ?2, ?3, ?4, strftime('%s','now'))
               ON CONFLICT(id) DO UPDATE SET
                 display_name = excluded.display_name"#,
            rusqlite::params![
                &device_id[..],
                &ed25519_pub[..],
                &x25519_pub[..],
                display_name
            ],
        )?;
        Ok(())
    }
}
