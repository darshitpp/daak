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
}
