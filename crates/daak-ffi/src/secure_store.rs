//! The UDL `SecureStore` callback, adapted to daak-core's byte-oriented
//! `SecretStore`.
//!
//! UniFFI hands a callback to the Rust side as `Box<dyn Trait>`, converted to an
//! Arc in the constructor so the engine can reach it from several threads.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
// Two traits are both called SecretStore: crate::SecureStore (the UDL callback,
// base64 strings, what the platform implements -- the one held inside) and
// daak-core's (raw bytes, what the engine wants -- the one implemented here),
// hence the alias.
use daak_core::crypto::secret_store::SecretStore as CoreSecretStore;
use daak_core::error::CoreError;
use std::sync::Arc;

use crate::SecureStore;

pub struct FfiSecretStore {
    inner: Arc<dyn SecureStore + Send + Sync>,
}

impl FfiSecretStore {
    pub fn new(inner: Arc<dyn SecureStore + Send + Sync>) -> Self {
        Self { inner }
    }
}

/// A keystore that is locked, unavailable or full is an ERROR, never a
/// fallback to a plaintext store: silently generating a fresh identity would
/// turn a device into a new one and break every pairing (R40(c)).
fn map_err<E: std::fmt::Display>(e: E) -> CoreError {
    CoreError::Io(std::io::Error::other(e.to_string()))
}

impl CoreSecretStore for FfiSecretStore {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, CoreError> {
        match self.inner.get(key.to_string()).map_err(map_err)? {
            None => Ok(None),
            Some(encoded) => B64.decode(encoded).map(Some).map_err(map_err),
        }
    }

    fn set(&self, key: &str, value: &[u8]) -> Result<(), CoreError> {
        self.inner
            .set(key.to_string(), B64.encode(value))
            .map_err(map_err)
    }

    fn delete(&self, key: &str) -> Result<(), CoreError> {
        self.inner.delete(key.to_string()).map_err(map_err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use daak_core::crypto::secret_store::SecretStore as CoreSecretStore;
    use std::collections::HashMap;
    use std::sync::Mutex;

    use crate::FfiStoreError;

    #[derive(Default)]
    struct Mem(Mutex<HashMap<String, String>>);

    #[derive(Default)]
    struct Failing;

    fn store_error(msg: &str) -> FfiStoreError {
        FfiStoreError::Store {
            reason: msg.to_string(),
        }
    }

    impl SecureStore for Mem {
        fn get(&self, key: String) -> Result<Option<String>, FfiStoreError> {
            Ok(self.0.lock().unwrap().get(&key).cloned())
        }
        fn set(&self, key: String, value: String) -> Result<(), FfiStoreError> {
            self.0.lock().unwrap().insert(key, value);
            Ok(())
        }
        fn delete(&self, key: String) -> Result<(), FfiStoreError> {
            self.0.lock().unwrap().remove(&key);
            Ok(())
        }
    }

    impl SecureStore for Failing {
        fn get(&self, _key: String) -> Result<Option<String>, FfiStoreError> {
            Err(store_error("keychain locked"))
        }
        fn set(&self, _key: String, _value: String) -> Result<(), FfiStoreError> {
            Err(store_error("keychain locked"))
        }
        fn delete(&self, _key: String) -> Result<(), FfiStoreError> {
            Err(store_error("keychain locked"))
        }
    }

    #[test]
    fn adapter_roundtrips_bytes_through_base64() {
        let adapter = FfiSecretStore::new(Arc::new(Mem::default()));
        adapter
            .set("identity.x25519.static", &[0u8, 1, 250, 255])
            .unwrap();
        let got = adapter.get("identity.x25519.static").unwrap().unwrap();
        assert_eq!(got, vec![0u8, 1, 250, 255]);
    }

    #[test]
    fn delete_then_get_is_none() {
        let adapter = FfiSecretStore::new(Arc::new(Mem::default()));
        adapter.set("identity.ed25519", b"seed").unwrap();
        adapter.delete("identity.ed25519").unwrap();
        assert_eq!(adapter.get("identity.ed25519").unwrap(), None);
    }

    /// A locked keystore is an ERROR at every verb, never a silent miss: an
    /// identity that reads back as absent regenerates and the device re-pairs
    /// as a new one (R40(c)).
    #[test]
    fn a_failing_keystore_errors_on_every_verb() {
        let adapter = FfiSecretStore::new(Arc::new(Failing));
        assert!(adapter.get("k").is_err());
        assert!(adapter.set("k", b"v").is_err());
        assert!(adapter.delete("k").is_err());
    }
}
