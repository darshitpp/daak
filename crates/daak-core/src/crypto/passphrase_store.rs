//! An optional at-rest wrapper: Argon2id -> ChaCha20-Poly1305 over whatever
//! store sits underneath.
//!
//! This is a NEW layer around the secret at rest. It does not touch the wire
//! handshake, the Noise XX suite or `derive_key`, and it changes no identity
//! key: a `PassphraseSecretStore` over an `OsSecretStore` stores the same two
//! 32-byte keys `import_from_store` already uses, byte for byte, only wrapped.

use std::sync::Arc;

use argon2::Argon2;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use zeroize::Zeroizing;

use crate::crypto::secret_store::SecretStore;
use crate::error::{CoreError, Result};

const SALT_KEY: &str = "identity.passphrase.salt";
const NONCE_LEN: usize = 12;

pub struct PassphraseSecretStore {
    inner: Arc<dyn SecretStore>,
    passphrase: Zeroizing<String>,
    key: std::sync::Mutex<Option<Zeroizing<[u8; 32]>>>,
}

impl PassphraseSecretStore {
    pub fn new(inner: Arc<dyn SecretStore>, passphrase: impl Into<String>) -> Self {
        Self {
            inner,
            passphrase: Zeroizing::new(passphrase.into()),
            key: std::sync::Mutex::new(None),
        }
    }

    fn salt(&self) -> Result<[u8; 16]> {
        if let Some(s) = self.inner.get(SALT_KEY)? {
            if s.len() == 16 {
                return Ok(s.try_into().expect("checked length"));
            }
        }
        let mut salt = Zeroizing::new([0u8; 16]);
        getrandom::getrandom(&mut salt[..]).map_err(random_err)?;
        self.inner.set(SALT_KEY, &salt[..])?;
        Ok(*salt)
    }

    fn key(&self) -> Result<Zeroizing<[u8; 32]>> {
        // ponytail: one lock held across the whole ~50ms Argon2id derivation,
        // so concurrent store users serialise behind a deliberately slow KDF.
        // Fine at daemon startup (the store is touched twice); revisit if it
        // ever runs per-transfer or per-file.
        let mut cache = self.key.lock().expect("passphrase key mutex");
        if let Some(k) = cache.as_ref() {
            return Ok(k.clone());
        }
        let salt = self.salt()?;
        let mut key = Zeroizing::new([0u8; 32]);
        Argon2::default()
            .hash_password_into(self.passphrase.as_bytes(), &salt, &mut key[..])
            .map_err(|e| CoreError::Protocol(format!("argon2: {e}")))?;
        *cache = Some(key.clone());
        Ok(key)
    }

    fn cipher(&self) -> Result<ChaCha20Poly1305> {
        let key = self.key()?;
        Ok(ChaCha20Poly1305::new(Key::from_slice(&key[..])))
    }
}

fn random_err(e: impl std::fmt::Display) -> CoreError {
    CoreError::Io(std::io::Error::other(format!("os randomness: {e}")))
}

impl SecretStore for PassphraseSecretStore {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        if key == SALT_KEY {
            return self.inner.get(key);
        }
        let Some(blob) = self.inner.get(key)? else {
            return Ok(None);
        };
        if blob.len() < NONCE_LEN {
            return Err(CoreError::Protocol("short wrapped secret".into()));
        }
        let (nonce, ct) = blob.split_at(NONCE_LEN);
        let plaintext = self
            .cipher()?
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: ct,
                    aad: key.as_bytes(),
                },
            )
            .map_err(|_| CoreError::Protocol("wrong passphrase".into()))?;
        Ok(Some(plaintext))
    }

    fn set(&self, key: &str, value: &[u8]) -> Result<()> {
        if key == SALT_KEY {
            return self.inner.set(key, value);
        }
        let mut nonce = Zeroizing::new([0u8; NONCE_LEN]);
        getrandom::getrandom(&mut nonce[..]).map_err(random_err)?;
        let ct = self
            .cipher()?
            .encrypt(
                Nonce::from_slice(&nonce[..]),
                Payload {
                    msg: value,
                    aad: key.as_bytes(),
                },
            )
            .map_err(|e| CoreError::Protocol(e.to_string()))?;
        let mut blob = nonce.to_vec();
        blob.extend_from_slice(&ct);
        self.inner.set(key, &blob)
    }

    fn delete(&self, key: &str) -> Result<()> {
        self.inner.delete(key)
    }
}

/// The OS keystore, wrapped in the passphrase gate when one was supplied.
///
/// `Err` when this platform has no keystore arm compiled in -- i.e. exactly
/// the iOS and Android catch-all in `os_secret_store`, whose methods all fail
/// loudly. The constructor itself does not touch the keystore, so the error is
/// raised by the FIRST `get`, not here; the `Result` is in the signature so no
/// caller can forget it is fallible.
pub fn platform_secret_store(passphrase: Option<&str>) -> Result<Arc<dyn SecretStore>> {
    let os: Arc<dyn SecretStore> = Arc::new(crate::crypto::os_secret_store::OsSecretStore::new(
        "dev.darshit.daak.daakd",
    ));
    Ok(match passphrase {
        Some(p) if !p.is_empty() => Arc::new(PassphraseSecretStore::new(os, p)),
        _ => os,
    })
}
