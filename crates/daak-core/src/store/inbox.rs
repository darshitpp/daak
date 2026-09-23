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
}
