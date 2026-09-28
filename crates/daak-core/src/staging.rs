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

    /// `name` is the name the manifest gives this item, NOT `src`'s leaf:
    /// the staging dir is flat, so a folder containing two `index.html` needs
    /// the manifest's disambiguated names to keep them apart.
    pub fn stage(&self, payload_id: &[u8; 16], src: &Path, name: &str) -> Result<PathBuf> {
        let dir = self.payload_dir(payload_id);
        std::fs::create_dir_all(&dir)?;
        // Same last-component filter the receiver applies to a peer-supplied
        // name: a name is ONE component, never a path. Without it `../x` stages
        // outside this payload dir, where `cleanup` never finds it. ponytail:
        // that filter is the whole ceiling -- the name is still not sanitised
        // for its own contents, only for its separators.
        let leaf = Path::new(name)
            .file_name()
            .and_then(|n| n.to_str())
            .filter(|n| !n.is_empty() && *n != "." && *n != "..");
        let Some(leaf) = leaf else {
            return Err(crate::CoreError::Transfer("item has no filename".into()));
        };
        let dest = dir.join(leaf);
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
        let staged = s.stage(&[7u8; 16], &f, "a.txt").unwrap();
        assert_eq!(std::fs::read(&staged).unwrap(), b"content");

        s.cleanup(&[7u8; 16]).unwrap();
        assert!(!staged.exists());
    }

    /// `name` comes from the manifest, and the staging dir is meant to be flat.
    /// A name carrying a separator would put the staged file OUTSIDE its own
    /// payload dir, where `cleanup` never removes it and the outbox drain
    /// never looks for it.
    #[test]
    fn a_name_carrying_a_separator_cannot_escape_the_payload_dir() {
        let root = tempfile::tempdir().unwrap();
        let src = tempfile::tempdir().unwrap();
        let f = src.path().join("a.txt");
        std::fs::write(&f, b"content").unwrap();

        let s = Staging::new(root.path().to_path_buf());
        let staged = s.stage(&[7u8; 16], &f, "../escaped.txt").unwrap();
        let payload_dir = root.path().join(hex::encode([7u8; 16]));
        assert_eq!(
            staged.parent().unwrap(),
            payload_dir,
            "a staged file must land directly inside its own payload dir"
        );
        assert!(
            !root.path().join("escaped.txt").exists(),
            "nothing may be staged outside the payload dir"
        );
    }
}
