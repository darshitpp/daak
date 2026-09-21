use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};

use crate::error::{CoreError, Result};

pub fn nonce(epoch: u32, counter: u64) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[0..4].copy_from_slice(&epoch.to_be_bytes());
    n[4..12].copy_from_slice(&counter.to_be_bytes());
    n
}

pub fn seal(key: &[u8; 32], nonce: &[u8; 12], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .encrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CoreError::Protocol("aead seal failed".into()))
}

pub fn open(key: &[u8; 32], nonce: &[u8; 12], aad: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| CoreError::Protocol("aead open failed".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_then_open_roundtrips() {
        let key = [4u8; 32];
        let n = nonce(0, 1);
        let ct = seal(&key, &n, b"aad", b"secret").unwrap();
        assert_ne!(&ct[..], b"secret");
        assert_eq!(open(&key, &n, b"aad", &ct).unwrap(), b"secret");
    }

    #[test]
    fn wrong_aad_or_key_fails() {
        let key = [4u8; 32];
        let n = nonce(0, 1);
        let ct = seal(&key, &n, b"aad", b"secret").unwrap();
        assert!(open(&key, &n, b"other", &ct).is_err());
        assert!(open(&[5u8; 32], &n, b"aad", &ct).is_err());
    }

    #[test]
    fn nonce_is_epoch_plus_counter() {
        let n = nonce(2, 0x0102030405060708);
        assert_eq!(&n[0..4], &2u32.to_be_bytes());
        assert_eq!(&n[4..12], &0x0102030405060708u64.to_be_bytes());
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let key = [4u8; 32];
        let n = nonce(0, 9);
        let mut ct = seal(&key, &n, b"", b"payload").unwrap();
        ct[0] ^= 0x01;
        assert!(open(&key, &n, b"", &ct).is_err());
    }
}
