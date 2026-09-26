use std::path::{Path, PathBuf};

use crate::error::Result;

pub struct Staging {
    root: PathBuf,
}

impl Staging {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn payload_dir(&self, payload_id: &[u8; 16]) -> PathBuf {
        self.root.join(hex::encode(payload_id))
    }

    pub fn stage(&self, payload_id: &[u8; 16], src: &Path) -> Result<PathBuf> {
        let dir = self.payload_dir(payload_id);
        std::fs::create_dir_all(&dir)?;
        let name = src
            .file_name()
            .ok_or_else(|| crate::CoreError::Transfer("source has no filename".into()))?;
        let dest = dir.join(name);
        if std::fs::hard_link(src, &dest).is_err() {
            std::fs::copy(src, &dest)?;
        }
        Ok(dest)
    }

    /// Path a binary item lands at once staged: root / <hex payload_id> / <name>.
    pub fn staged_path(&self, payload_id: &[u8; 16], name: &str) -> PathBuf {
        self.payload_dir(payload_id).join(name)
    }

    pub fn cleanup(&self, payload_id: &[u8; 16]) -> Result<()> {
        let dir = self.payload_dir(payload_id);
        if dir.exists() {
            std::fs::remove_dir_all(dir)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_copies_file_and_cleanup_removes_it() {
        let root = tempfile::tempdir().unwrap();
        let src = tempfile::tempdir().unwrap();
        let f = src.path().join("a.txt");
        std::fs::write(&f, b"content").unwrap();

        let s = Staging::new(root.path().to_path_buf());
        let staged = s.stage(&[7u8; 16], &f).unwrap();
        assert_eq!(std::fs::read(&staged).unwrap(), b"content");

        s.cleanup(&[7u8; 16]).unwrap();
        assert!(!staged.exists());
    }
}
