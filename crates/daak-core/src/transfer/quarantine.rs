//! Per-item quarantine for hash-failed inbound files.
//!
//! Layout: `<out_dir>/quarantine/<hex payload_id>/<safe item name>`. Isolating
//! the bad FILE rather than failing the whole transfer is the point: one
//! corrupt chunk must not cost the user the other 99 files.

use std::path::{Path, PathBuf};

use crate::error::Result;

pub struct Quarantine {
    root: PathBuf,
}

impl Quarantine {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// The holding slot for one item. `name` is reduced to its last path
    /// component HERE, not merely documented: `name` is a pub parameter and the
    /// receiver stores the RAW wire name, so any future caller reading it back
    /// would otherwise join a traversal prefix onto the root.
    pub fn slot(&self, payload_id: &[u8; 16], name: &str) -> PathBuf {
        let leaf = match Path::new(name).file_name().and_then(|n| n.to_str()) {
            Some(n) if !n.is_empty() && n != "." && n != ".." => n.to_owned(),
            _ => "unnamed".to_owned(),
        };
        self.root.join(hex::encode(payload_id)).join(leaf)
    }

    /// Move a hash-failed file into quarantine and return its held path.
    pub fn hold(&self, payload_id: &[u8; 16], name: &str, tmp: &Path) -> Result<PathBuf> {
        let dest = self.slot(payload_id, name);
        if let Some(dir) = dest.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::rename(tmp, &dest)?;
        Ok(dest)
    }

    /// Put a quarantined file back so the item can be re-fetched into place.
    pub fn release(&self, held: &Path, dest: &Path) -> Result<()> {
        if let Some(dir) = dest.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::rename(held, dest)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quarantine_moves_temp_file_then_retry_restores_it() {
        let root = tempfile::tempdir().unwrap();
        let tmp = root.path().join("part.tmp");
        std::fs::write(&tmp, b"partial").unwrap();

        let q = Quarantine::new(root.path().join("quarantine"));
        let held = q.hold(&[9u8; 16], "part.bin", &tmp).unwrap();
        assert!(!tmp.exists(), "temp file moved out of the receive dir");
        assert!(held.exists());
        // Assert the ROOT, not the internal layout: the per-payload slot shape is
        // pinned once, by the receiver test that actually looks a held file up.
        assert!(
            held.starts_with(root.path().join("quarantine")),
            "held path must sit under the quarantine root, got {held:?}"
        );

        // Quarantine::release has no production caller yet (the retry loop is
        // parked), so the release half of this is a contract test, not a
        // reachable path. store::Db pins the state transition itself.
        q.release(&held, &tmp).unwrap();
        assert!(tmp.exists());
        assert_eq!(std::fs::read(&tmp).unwrap(), b"partial");
    }

    /// I-1: `name` is a pub parameter and the receiver stores the RAW wire name
    /// in transfer_items.name, so any future caller reading it back could pass a
    /// traversal prefix. slot must reduce it to the last component itself.
    #[test]
    fn slot_cannot_escape_the_quarantine_root() {
        let root = tempfile::tempdir().unwrap();
        let q = Quarantine::new(root.path().join("quarantine"));
        std::fs::create_dir_all(root.path().join("quarantine").join(hex::encode([9u8; 16])))
            .unwrap();
        let base = root.path().canonicalize().unwrap();
        let under_root = |p: &Path| {
            assert!(
                !p.components().any(|c| c == std::path::Component::ParentDir),
                "a ParentDir component survives in {p:?}"
            );
            p.parent()
                .unwrap()
                .canonicalize()
                .unwrap()
                .starts_with(&base)
        };

        assert!(
            under_root(&q.slot(&[9u8; 16], "../../escaped.bin")),
            "traversal prefix must be stripped"
        );
        assert!(
            under_root(&q.slot(&[9u8; 16], "..")),
            "bare dotdot must stay under the root"
        );
    }
}
