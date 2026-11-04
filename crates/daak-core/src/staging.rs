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

    /// Stage `src` as the binary item `index`. The staged file is
    /// `item_<index>`, so two item names never collide in staging. The name is
    /// internal and never goes on the wire.
    pub fn stage(&self, payload_id: &[u8; 16], src: &Path, index: u32) -> Result<PathBuf> {
        let dir = self.payload_dir(payload_id);
        std::fs::create_dir_all(&dir)?;
        let dest = self.staged_path(payload_id, index);
        if std::fs::hard_link(src, &dest).is_err() {
            // The copy must create a NEW file. An existing `dest` can be a hard
            // link to the source of an earlier stage. A copy that truncates
            // `dest` then writes into the user's source file.
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

    /// The path of the binary item `index` once staged:
    /// root / <hex payload_id> / item_<index>.
    pub fn staged_path(&self, payload_id: &[u8; 16], index: u32) -> PathBuf {
        self.payload_dir(payload_id).join(format!("item_{index}"))
    }

    /// The staged file of the binary item `index`. The function looks for
    /// `item_<index>` first. Then it looks for the old path, which ends in the
    /// last component of the item name. An outbox row staged before the
    /// upgrade uses the old path. If neither file exists, the function returns
    /// `item_<index>`.
    pub fn find_staged(&self, payload_id: &[u8; 16], index: u32, name: Option<&str>) -> PathBuf {
        let path = self.staged_path(payload_id, index);
        if path.exists() {
            return path;
        }
        name.and_then(|n| Path::new(n).file_name())
            .map(|leaf| self.payload_dir(payload_id).join(leaf))
            .filter(|old| old.exists())
            .unwrap_or(path)
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
        let staged = s.stage(&[7u8; 16], &f, 0).unwrap();
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
        s.stage(&[1u8; 16], &f, 0).unwrap();
        s.stage(&[2u8; 16], &f, 0).unwrap();
        std::fs::create_dir(root.path().join("not-a-payload")).unwrap();

        let keep = std::collections::HashSet::from([[1u8; 16]]);
        assert_eq!(s.sweep_orphans(&keep).unwrap(), 1);

        assert!(root.path().join(hex::encode([1u8; 16])).exists());
        assert!(!root.path().join(hex::encode([2u8; 16])).exists());
        assert!(root.path().join("not-a-payload").exists());
    }

    /// Staging keys each file on its item index. Two names that differ only
    /// by case collide on a case-insensitive file system, but their indices do
    /// not. Both files stage, and each source keeps its bytes.
    #[test]
    fn two_sources_whose_names_differ_only_by_case_stage_as_two_files() {
        let root = tempfile::tempdir().unwrap();
        let src = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(src.path().join("x")).unwrap();
        std::fs::create_dir_all(src.path().join("y")).unwrap();
        let first = src.path().join("x/A.txt");
        let second = src.path().join("y/a.txt");
        std::fs::write(&first, b"first file bytes").unwrap();
        std::fs::write(&second, b"second").unwrap();

        let s = Staging::new(root.path().to_path_buf());
        s.stage(&[7u8; 16], &first, 0).unwrap();
        s.stage(&[7u8; 16], &second, 1).unwrap();

        assert_eq!(std::fs::read(&first).unwrap(), b"first file bytes");
        assert_eq!(std::fs::read(&second).unwrap(), b"second");
        assert_eq!(
            std::fs::read(s.staged_path(&[7u8; 16], 0)).unwrap(),
            b"first file bytes"
        );
        assert_eq!(
            std::fs::read(s.staged_path(&[7u8; 16], 1)).unwrap(),
            b"second"
        );
    }

    /// A second stage of one index gives an error. It does not truncate the
    /// staged file, which can be a hard link to the first source.
    #[test]
    fn a_second_stage_of_one_index_is_an_error_and_keeps_the_first_bytes() {
        let root = tempfile::tempdir().unwrap();
        let src = tempfile::tempdir().unwrap();
        let first = src.path().join("one.txt");
        let second = src.path().join("two.txt");
        std::fs::write(&first, b"one").unwrap();
        std::fs::write(&second, b"two").unwrap();

        let s = Staging::new(root.path().to_path_buf());
        s.stage(&[7u8; 16], &first, 0).unwrap();
        assert!(s.stage(&[7u8; 16], &second, 0).is_err());
        assert_eq!(std::fs::read(&first).unwrap(), b"one");
        assert_eq!(std::fs::read(s.staged_path(&[7u8; 16], 0)).unwrap(), b"one");
    }

    /// `find_staged` prefers `item_<index>`. It falls back to the old
    /// name-based path, and it never leaves the payload dir.
    #[test]
    fn find_staged_prefers_the_index_path_then_the_old_name_path() {
        let root = tempfile::tempdir().unwrap();
        let src = tempfile::tempdir().unwrap();
        let f = src.path().join("a.txt");
        std::fs::write(&f, b"content").unwrap();
        let s = Staging::new(root.path().to_path_buf());
        let dir = root.path().join(hex::encode([7u8; 16]));

        // Nothing staged: the index path.
        assert_eq!(
            s.find_staged(&[7u8; 16], 0, Some("a.txt")),
            s.staged_path(&[7u8; 16], 0)
        );
        // The old layout only: the old path.
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), b"old").unwrap();
        assert_eq!(
            s.find_staged(&[7u8; 16], 0, Some("a.txt")),
            dir.join("a.txt")
        );
        // A separator in the name keeps the lookup inside the payload dir.
        assert_eq!(
            s.find_staged(&[7u8; 16], 0, Some("../a.txt")),
            dir.join("a.txt")
        );
        // Both layouts: the index path wins.
        s.stage(&[7u8; 16], &f, 0).unwrap();
        assert_eq!(
            s.find_staged(&[7u8; 16], 0, Some("a.txt")),
            s.staged_path(&[7u8; 16], 0)
        );
    }
}
