use std::collections::HashMap;
use std::sync::Mutex;

use zeroize::Zeroizing;

use crate::error::Result;

pub trait SecretStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>>;
    fn set(&self, key: &str, value: &[u8]) -> Result<()>;
    fn delete(&self, key: &str) -> Result<()>;
}

#[derive(Default)]
pub struct MemorySecretStore {
    map: Mutex<HashMap<String, Zeroizing<Vec<u8>>>>,
}

impl SecretStore for MemorySecretStore {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        Ok(self.map.lock().unwrap().get(key).map(|v| v.to_vec()))
    }

    fn set(&self, key: &str, value: &[u8]) -> Result<()> {
        self.map
            .lock()
            .unwrap()
            .insert(key.to_string(), Zeroizing::new(value.to_vec()));
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<()> {
        self.map.lock().unwrap().remove(key);
        Ok(())
    }
}

/// Test/dev only. Plaintext on disk, 0600. Never enabled in release builds.
/// ponytail: insecure file store for CI/dev; replace with OS keystore in Phase 4.
#[cfg(feature = "dev-insecure-store")]
pub struct FileSecretStore {
    dir: std::path::PathBuf,
}

#[cfg(feature = "dev-insecure-store")]
impl FileSecretStore {
    pub fn new(dir: impl Into<std::path::PathBuf>) -> Result<Self> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }

    fn path(&self, key: &str) -> std::path::PathBuf {
        self.dir.join(key)
    }
}

#[cfg(feature = "dev-insecure-store")]
impl SecretStore for FileSecretStore {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        match std::fs::read(self.path(key)) {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn set(&self, key: &str, value: &[u8]) -> Result<()> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(self.path(key))?;
        f.write_all(value)?;
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<()> {
        match std::fs::remove_file(self.path(key)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

/// The store a SHIPPED desktop daemon uses: one 0600 file per key under a
/// caller-chosen directory, so the device id and static key survive a restart
/// and pairing does not silently break on relaunch.
///
/// This is deliberately NOT `FileSecretStore`. That one is behind the
/// `dev-insecure-store` feature and only daak-cli enables it, and a locked
/// constraint says the feature stays that way. This one is always compiled in
/// because an app or a daemon has no other way to persist its identity yet.
///
/// The 0600 comes from `OpenOptions::mode`, which applies only when the file is
/// CREATED; a later write to an existing key file leaves its mode as it already
/// was. That is why `set` is only ever called for a key that does not exist
/// (see `import_from_store`) rather than rewritten in place.
///
/// `mode` is Unix-only, so it is cfg'd out: without it the file inherits the
/// directory's mode, which on Windows is the user's profile ACL and is the
/// platform's own protection.
///
/// ponytail: plaintext at rest, guarded only by mode bits. The upgrade path is
/// the OS keystore (iOS Keychain / Android Keystore / DPAPI), Phase 5. The
/// alternative -- a fresh identity per launch -- is strictly worse, because it
/// breaks pairing and every stored pairing row.
pub struct PersistentFileStore {
    dir: std::path::PathBuf,
}

impl PersistentFileStore {
    pub fn new(dir: impl Into<std::path::PathBuf>) -> Result<Self> {
        let dir = dir.into();
        #[cfg(unix)]
        {
            use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&dir)?;
            // An existing directory keeps its old mode, so set it again.
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        }
        #[cfg(not(unix))]
        std::fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }

    fn path(&self, key: &str) -> std::path::PathBuf {
        self.dir.join(key)
    }
}

impl SecretStore for PersistentFileStore {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        match std::fs::read(self.path(key)) {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn set(&self, key: &str, value: &[u8]) -> Result<()> {
        use std::io::Write;
        let mut opts = std::fs::OpenOptions::new();
        opts.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let path = self.path(key);
        // Never write a key through a symlink that points elsewhere.
        if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(std::io::Error::other("key path is a symlink").into());
        }
        let mut f = opts.open(&path)?;
        // The mode in `opts` applies only to a new file, so fix an old file too.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        f.write_all(value)?;
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<()> {
        match std::fs::remove_file(self.path(key)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_roundtrips_and_deletes() {
        let s = MemorySecretStore::default();
        assert!(s.get("k").unwrap().is_none());
        s.set("k", b"v").unwrap();
        assert_eq!(s.get("k").unwrap().as_deref(), Some(&b"v"[..]));
        s.delete("k").unwrap();
        assert!(s.get("k").unwrap().is_none());
    }

    #[cfg(unix)]
    mod file_modes {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        fn mode(p: &std::path::Path) -> u32 {
            std::fs::metadata(p).unwrap().permissions().mode() & 0o777
        }

        #[test]
        fn the_key_directory_is_private() {
            let root = tempfile::tempdir().unwrap();
            let dir = root.path().join("a").join("keys");
            PersistentFileStore::new(&dir).unwrap();
            assert_eq!(mode(&dir), 0o700);
        }

        #[test]
        fn set_makes_an_existing_loose_file_private() {
            let root = tempfile::tempdir().unwrap();
            let store = PersistentFileStore::new(root.path().join("keys")).unwrap();
            let file = root.path().join("keys").join("k");
            std::fs::write(&file, b"old").unwrap();
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
            store.set("k", b"new").unwrap();
            assert_eq!(mode(&file), 0o600);
        }

        #[test]
        fn set_refuses_to_write_through_a_symlink() {
            let root = tempfile::tempdir().unwrap();
            let store = PersistentFileStore::new(root.path().join("keys")).unwrap();
            let target = root.path().join("elsewhere");
            std::fs::write(&target, b"keep").unwrap();
            std::os::unix::fs::symlink(&target, root.path().join("keys").join("k")).unwrap();
            assert!(store.set("k", b"new").is_err());
            assert_eq!(std::fs::read(&target).unwrap(), b"keep");
        }
    }
}
