pub mod identity;
pub mod pairings;

use std::path::Path;

use rusqlite::Connection;

use crate::error::Result;

pub struct Db {
    conn: Connection,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        Ok(Self {
            conn: Connection::open(path)?,
        })
    }

    pub fn open_in_memory() -> Result<Self> {
        Ok(Self {
            conn: Connection::open_in_memory()?,
        })
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    pub fn migrate(&self) -> Result<()> {
        self.conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS identity (
              id           INTEGER PRIMARY KEY CHECK (id = 1),
              device_id    BLOB NOT NULL,
              ed25519_pub  BLOB NOT NULL,
              x25519_pub   BLOB NOT NULL,
              display_name TEXT NOT NULL,
              created_at   INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS devices (
              device_id      BLOB PRIMARY KEY,
              display_name   TEXT NOT NULL,
              ed25519_pub    BLOB,
              x25519_pub     BLOB,
              last_seen_addr TEXT,
              last_seen_at   INTEGER,
              state          TEXT NOT NULL DEFAULT 'offline'
            );

            CREATE TABLE IF NOT EXISTS pairings (
              peer_device_id  BLOB PRIMARY KEY REFERENCES devices(device_id),
              state           TEXT NOT NULL,
              paired_at       INTEGER NOT NULL,
              last_session_at INTEGER,
              verify_key      BLOB NOT NULL,
              static_dh_pub   BLOB NOT NULL,
              label           TEXT
            );

            CREATE TABLE IF NOT EXISTS replay_guard (
              peer_device_id BLOB NOT NULL,
              direction      TEXT NOT NULL,
              max_counter    INTEGER NOT NULL,
              epoch          INTEGER NOT NULL DEFAULT 0,
              seen           BLOB NOT NULL DEFAULT x'',
              PRIMARY KEY (peer_device_id, direction)
            );
            "#,
        )?;
        Ok(())
    }
}
