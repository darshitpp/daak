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
            // The copy must create a NEW file. An existing `dest` can be a hard
            // link to the source of an earlier item. This occurs when two names
            // differ only in case on a case-insensitive file system. A copy
            // that truncates `dest` then writes into the user's source file.
            let mut from = std::fs::File::open(src)?;
            let mut to = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&dest)
                .map_err(|e| {
                    // No name in the text: a log can hold it, and it is user data.
                    crate::CoreError::Transfer(format!("cannot stage an item: {e}"))
                })?;
            std::io::copy(&mut from, &mut to)?;
        }
        Ok(dest)
    }

    /// Path a binary item lands at once staged: root / <hex payload_id> / <name>.
    pub fn staged_path(&self, payload_id: &[u8; 16], name: &str) -> PathBuf {
        self.payload_dir(payload_id).join(name)
    }

    /// Remove every payload dir whose id is not in `keep`. Returns the count.
    /// A name that is not a 16-byte hex id is not a payload dir and stays.
    pub fn sweep_orphans(&self, keep: &std::collections::HashSet<[u8; 16]>) -> Result<usize> {
        let mut removed = 0;
        for entry in std::fs::read_dir(&self.root)? {
            let entry = entry?;
            let id = entry
                .file_name()
                .to_str()
                .and_then(|n| hex::decode(n).ok())
                .and_then(|b| <[u8; 16]>::try_from(b).ok());
            if let Some(id) = id {
                if !keep.contains(&id) && entry.path().is_dir() {
                    std::fs::remove_dir_all(entry.path())?;
                    removed += 1;
                }
            }
        }
        Ok(removed)
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

    /// Startup sweep (spec 7.1): a crash can leave a payload dir with no live
    /// outbox row. Only the ids in `keep` survive. A directory whose name is not
    /// a 16-byte hex id is not ours, so the sweep leaves it alone.
    #[test]
    fn sweep_removes_orphan_payload_dirs_and_keeps_live_and_foreign_ones() {
        let root = tempfile::tempdir().unwrap();
        let src = tempfile::tempdir().unwrap();
        let f = src.path().join("a.txt");
        std::fs::write(&f, b"content").unwrap();
        let s = Staging::new(root.path().to_path_buf());
        s.stage(&[1u8; 16], &f, "a.txt").unwrap();
        s.stage(&[2u8; 16], &f, "a.txt").unwrap();
        std::fs::create_dir(root.path().join("not-a-payload")).unwrap();

        let keep = std::collections::HashSet::from([[1u8; 16]]);
        assert_eq!(s.sweep_orphans(&keep).unwrap(), 1);

        assert!(root.path().join(hex::encode([1u8; 16])).exists());
        assert!(!root.path().join(hex::encode([2u8; 16])).exists());
        assert!(root.path().join("not-a-payload").exists());
    }

    /// On a case-insensitive file system, `a.txt` names the file that
    /// `A.txt` already holds. That file is a hard link to the FIRST source. The
    /// second stage must not write into it, so the first source keeps its
    /// bytes. The second stage gives an error or a distinct file.
    #[test]
    fn a_second_stage_onto_a_taken_name_never_changes_the_first_source() {
        let root = tempfile::tempdir().unwrap();
        let src = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(src.path().join("x")).unwrap();
        std::fs::create_dir_all(src.path().join("y")).unwrap();
        let first = src.path().join("x/A.txt");
        let second = src.path().join("y/a.txt");
        std::fs::write(&first, b"first file bytes").unwrap();
        std::fs::write(&second, b"second").unwrap();

        let s = Staging::new(root.path().to_path_buf());
        s.stage(&[7u8; 16], &first, "A.txt").unwrap();
        let again = s.stage(&[7u8; 16], &second, "a.txt");

        assert_eq!(
            std::fs::read(&first).unwrap(),
            b"first file bytes",
            "the first source file must stay byte-identical"
        );
        assert_eq!(std::fs::read(&second).unwrap(), b"second");
        if let Ok(staged) = again {
            assert_eq!(std::fs::read(staged).unwrap(), b"second");
            assert_eq!(
                std::fs::read(s.staged_path(&[7u8; 16], "A.txt")).unwrap(),
                b"first file bytes"
            );
        }
    }

    /// A stage onto a name that already holds a file gives an error. It does
    /// not truncate the file.
    #[test]
    fn a_stage_onto_an_existing_name_is_an_error() {
        let root = tempfile::tempdir().unwrap();
        let src = tempfile::tempdir().unwrap();
        let first = src.path().join("one.txt");
        let second = src.path().join("two.txt");
        std::fs::write(&first, b"one").unwrap();
        std::fs::write(&second, b"two").unwrap();

        let s = Staging::new(root.path().to_path_buf());
        s.stage(&[7u8; 16], &first, "same.txt").unwrap();
        assert!(s.stage(&[7u8; 16], &second, "same.txt").is_err());
        assert_eq!(std::fs::read(&first).unwrap(), b"one");
        assert_eq!(
            std::fs::read(s.staged_path(&[7u8; 16], "same.txt")).unwrap(),
            b"one"
        );
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
