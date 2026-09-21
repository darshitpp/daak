use crate::error::Result;

use super::Db;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pairing {
    pub peer_device_id: [u8; 16],
    pub state: String,
    pub paired_at: i64,
    pub verify_key: [u8; 32],
    pub static_dh_pub: [u8; 32],
    pub label: Option<String>,
}

impl Db {
    pub fn upsert_pairing(&self, p: &Pairing) -> Result<()> {
        let conn = self.conn();
        conn.execute(
            r#"INSERT INTO devices (device_id, display_name, state)
                   VALUES (?1, ?2, 'paired')
               ON CONFLICT(device_id) DO NOTHING"#,
            rusqlite::params![&p.peer_device_id[..], p.label.clone().unwrap_or_default()],
        )?;
        conn.execute(
            r#"INSERT INTO pairings
                 (peer_device_id, state, paired_at, verify_key, static_dh_pub, label)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6)
               ON CONFLICT(peer_device_id) DO UPDATE SET
                 state = excluded.state,
                 label = excluded.label"#,
            rusqlite::params![
                &p.peer_device_id[..],
                p.state,
                p.paired_at,
                &p.verify_key[..],
                &p.static_dh_pub[..],
                p.label,
            ],
        )?;
        Ok(())
    }

    pub fn get_pairing(&self, id: &[u8; 16]) -> Result<Option<Pairing>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT peer_device_id, state, paired_at, verify_key, static_dh_pub, label
               FROM pairings WHERE peer_device_id = ?1",
        )?;
        let mut rows = stmt.query(rusqlite::params![&id[..]])?;
        match rows.next()? {
            Some(r) => Ok(Some(row_to_pairing(r)?)),
            None => Ok(None),
        }
    }

    pub fn list_pairings(&self) -> Result<Vec<Pairing>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT peer_device_id, state, paired_at, verify_key, static_dh_pub, label FROM pairings",
        )?;
        let rows = stmt.query_map([], row_to_pairing)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn revoke_pairing(&self, id: &[u8; 16]) -> Result<()> {
        self.conn().execute(
            "UPDATE pairings SET state = 'revoked' WHERE peer_device_id = ?1",
            rusqlite::params![&id[..]],
        )?;
        Ok(())
    }
}

fn row_to_pairing(r: &rusqlite::Row<'_>) -> rusqlite::Result<Pairing> {
    let id: Vec<u8> = r.get(0)?;
    let vk: Vec<u8> = r.get(3)?;
    let dh: Vec<u8> = r.get(4)?;
    let to16 = |v: Vec<u8>| -> rusqlite::Result<[u8; 16]> {
        v.try_into().map_err(|_| {
            rusqlite::Error::InvalidColumnType(0, "device_id".into(), rusqlite::types::Type::Blob)
        })
    };
    let to32 = |v: Vec<u8>, c: usize| -> rusqlite::Result<[u8; 32]> {
        v.try_into().map_err(|_| {
            rusqlite::Error::InvalidColumnType(c, "key".into(), rusqlite::types::Type::Blob)
        })
    };
    Ok(Pairing {
        peer_device_id: to16(id)?,
        state: r.get(1)?,
        paired_at: r.get(2)?,
        verify_key: to32(vk, 3)?,
        static_dh_pub: to32(dh, 4)?,
        label: r.get(5)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn example(id: u8) -> Pairing {
        Pairing {
            peer_device_id: [id; 16],
            state: "trusted".into(),
            paired_at: 1_700_000_000,
            verify_key: [id; 32],
            static_dh_pub: [id.wrapping_add(1); 32],
            label: Some(format!("peer {id}")),
        }
    }

    #[test]
    fn upsert_then_get_roundtrips() {
        let db = crate::store::Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        let p = example(3);
        db.upsert_pairing(&p).unwrap();
        assert_eq!(db.get_pairing(&p.peer_device_id).unwrap().unwrap(), p);
    }

    #[test]
    fn upsert_updates_state_not_duplicates() {
        let db = crate::store::Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        let mut p = example(4);
        db.upsert_pairing(&p).unwrap();
        p.state = "revoked".into();
        db.upsert_pairing(&p).unwrap();
        assert_eq!(db.list_pairings().unwrap().len(), 1);
        assert_eq!(
            db.get_pairing(&p.peer_device_id).unwrap().unwrap().state,
            "revoked"
        );
    }

    #[test]
    fn unknown_pairing_is_none() {
        let db = crate::store::Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        assert!(db.get_pairing(&[9u8; 16]).unwrap().is_none());
    }
}
