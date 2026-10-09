use crate::error::Result;

use super::Db;
use rusqlite::OptionalExtension;
use std::net::SocketAddr;

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
    /// Record the address a completed pairing handshake proved.
    ///
    /// The device map in the engine is RAM and starts empty on every launch, so
    /// a paired peer had no address after a restart and every send failed with
    /// "peer is not discovered" until the next mDNS announce. This column
    /// existed and stayed NULL. SQLite is the source of truth, so the proven
    /// address goes here.
    pub fn set_peer_addr(&self, id: &[u8; 16], addr: SocketAddr) -> Result<()> {
        self.conn().execute(
            "UPDATE devices SET last_seen_addr = ?2 WHERE device_id = ?1",
            rusqlite::params![&id[..], addr.to_string()],
        )?;
        Ok(())
    }

    /// Every live pairing that has a proven address, so `Engine::start` can
    /// seed the device map without waiting for an announce.
    pub fn paired_addrs(&self) -> Result<Vec<([u8; 16], String, SocketAddr)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT d.device_id, d.display_name, d.last_seen_addr
               FROM devices d
               JOIN pairings p ON p.peer_device_id = d.device_id
              WHERE p.state <> 'revoked'
                AND d.last_seen_addr IS NOT NULL
                AND d.last_seen_addr <> ''",
        )?;
        let rows = stmt.query_map([], |r| {
            let id: Vec<u8> = r.get(0)?;
            let name: String = r.get(1)?;
            let addr: String = r.get(2)?;
            Ok((id, name, addr))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, name, addr) = row?;
            let id: [u8; 16] = match id.try_into() {
                Ok(v) => v,
                Err(_) => continue,
            };
            // A row that does not parse is a corrupt row, not a fatal error.
            // Skipping it keeps a peer with a broken address out of the map
            // rather than letting it fail every send with a parse error.
            if let Ok(addr) = addr.parse::<SocketAddr>() {
                out.push((id, name, addr));
            }
        }
        Ok(out)
    }

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

    /// True only for a live pairing. A revoked row still exists, so a bare
    /// "has a row" check reads a removed peer as paired.
    pub fn is_trusted(&self, id: &[u8; 16]) -> bool {
        self.get_pairing(id)
            .ok()
            .flatten()
            .is_some_and(|p| p.state == "trusted")
    }

    pub fn list_pairings(&self) -> Result<Vec<Pairing>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT peer_device_id, state, paired_at, verify_key, static_dh_pub, label FROM pairings",
        )?;
        let rows = stmt.query_map([], row_to_pairing)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Unpair a peer from THIS device. Neither side has to agree: the pairing
    /// is LOCAL trust.
    ///
    /// The row is MARKED `revoked`, not deleted, and `paired_addrs` already
    /// filters `state <> 'revoked'`, so the peer stops being seeded into the
    /// device map. R42f: the proven address is cleared with the state. A
    /// surviving address would let a revoked peer be dialled again before
    /// anyone re-paired it, which is the opposite of what revoke means.
    pub fn revoke_pairing(&self, id: &[u8; 16]) -> Result<()> {
        let conn = self.conn();
        conn.execute(
            "UPDATE pairings SET state = 'revoked' WHERE peer_device_id = ?1",
            rusqlite::params![&id[..]],
        )?;
        conn.execute(
            "UPDATE devices SET last_seen_addr = NULL WHERE device_id = ?1",
            rusqlite::params![&id[..]],
        )?;
        Ok(())
    }

    /// True when a pairing row exists for `peer` and its state is `revoked`.
    ///
    /// A peer with NO row is not revoked: an unknown peer is refused by the
    /// existing "unpaired inbound connection" check, not by this one. Only the
    /// explicit revoked state refuses a peer that was once trusted.
    pub fn is_revoked(&self, peer: &[u8; 16]) -> Result<bool> {
        let state: Option<String> = self
            .conn()
            .query_row(
                "SELECT state FROM pairings WHERE peer_device_id = ?1",
                rusqlite::params![&peer[..]],
                |r| r.get(0),
            )
            .optional()?;
        Ok(state.as_deref() == Some("revoked"))
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

    #[test]
    fn pairing_survives_a_file_backed_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daak.db");
        let p = example(9);
        {
            let db = crate::store::Db::open(&path).unwrap();
            db.migrate().unwrap();
            db.upsert_pairing(&p).unwrap();
        }
        let db = crate::store::Db::open(&path).unwrap();
        db.migrate().unwrap();
        assert_eq!(db.get_pairing(&[9u8; 16]).unwrap().unwrap(), p);
    }
}
