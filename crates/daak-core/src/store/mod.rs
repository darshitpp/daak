pub mod chunks;
pub mod identity;
pub mod inbox;
pub mod outbox;
pub mod pairings;
pub mod transfers;

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;

use crate::error::Result;

pub struct Db {
    // rusqlite Connection is Send but not Sync; the engine shares one Arc<Db>
    // across the accept loop and its own tasks, so guard the connection here.
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        Ok(Self {
            conn: Mutex::new(Connection::open(path)?),
        })
    }

    pub fn open_in_memory() -> Result<Self> {
        Ok(Self {
            conn: Mutex::new(Connection::open_in_memory()?),
        })
    }

    pub fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().expect("db lock poisoned")
    }

    pub fn migrate(&self) -> Result<()> {
        self.conn().execute_batch(
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
            CREATE TABLE IF NOT EXISTS transfers (
              transfer_id    BLOB PRIMARY KEY,
              payload_id     BLOB NOT NULL,
              peer_device_id BLOB NOT NULL,
              direction      TEXT NOT NULL,
              kind           TEXT NOT NULL,
              state          TEXT NOT NULL,
              bytes_total    INTEGER NOT NULL,
              bytes_done     INTEGER NOT NULL DEFAULT 0,
              item_count     INTEGER NOT NULL,
              created_at     INTEGER NOT NULL,
              updated_at     INTEGER NOT NULL,
              manifest       BLOB NOT NULL,
              error          TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_transfers_peer_state ON transfers(peer_device_id, state);

            CREATE TABLE IF NOT EXISTS transfer_items (
              transfer_id BLOB NOT NULL REFERENCES transfers(transfer_id) ON DELETE CASCADE,
              item_index  INTEGER NOT NULL,
              type        TEXT NOT NULL,
              name        TEXT,
              mime        TEXT,
              size        INTEGER,
              hash        BLOB,
              dest_path   TEXT,
              state       TEXT NOT NULL,
              PRIMARY KEY (transfer_id, item_index)
            );

            CREATE TABLE IF NOT EXISTS chunk_state (
              transfer_id BLOB NOT NULL,
              item_index  INTEGER NOT NULL,
              word_index  INTEGER NOT NULL,
              bitmap      INTEGER NOT NULL,
              PRIMARY KEY (transfer_id, item_index, word_index)
            );

            CREATE TABLE IF NOT EXISTS outbox (
              id              BLOB PRIMARY KEY,
              payload_id      BLOB NOT NULL,
              peer_device_id  BLOB NOT NULL,
              manifest        BLOB NOT NULL,
              total_bytes     INTEGER NOT NULL,
              attempts        INTEGER NOT NULL DEFAULT 0,
              next_attempt_at INTEGER NOT NULL DEFAULT 0,
              state           TEXT NOT NULL,
              created_at      INTEGER NOT NULL,
              updated_at      INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_outbox_state_next ON outbox(state, next_attempt_at);

            CREATE TABLE IF NOT EXISTS inbox_history (
              id             BLOB PRIMARY KEY,
              transfer_id    BLOB NOT NULL,
              peer_device_id BLOB NOT NULL,
              kind           TEXT NOT NULL,
              item_count     INTEGER NOT NULL,
              summary        TEXT NOT NULL,
              received_at    INTEGER NOT NULL,
              saved_paths    TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_inbox_received ON inbox_history(received_at DESC);
            "#,
        )?;
        Ok(())
    }
}
