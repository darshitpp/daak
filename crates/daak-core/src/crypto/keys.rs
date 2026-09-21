use blake2::digest::consts::U32;
use blake2::digest::{KeyInit, Mac};
use blake2::Blake2sMac;

pub const REKEY_BYTES: u64 = 1 << 30;

/// PRF-based key derivation over keyed BLAKE2s (the plan's `HKDF-BLAKE2s` is not
/// expressible with hkdf 0.12 because blake2's Blake2s256 uses Lazy buffering).
/// Distinct (info, epoch) pairs yield independent 32-byte keys; `base` is a
/// 32-byte PRF key, so domain separation comes from info + epoch, not the key.
pub fn derive_key(base: &[u8; 32], info: &[u8], epoch: u64) -> [u8; 32] {
    let mut mac =
        <Blake2sMac<U32> as KeyInit>::new_from_slice(base).expect("valid 32-byte blake2s mac key");
    mac.update(b"daak-kdf");
    mac.update(&epoch.to_be_bytes());
    mac.update(info);
    mac.finalize().into_bytes().into()
}

pub fn directional_keys(handshake_hash: &[u8], initiator: bool) -> ([u8; 32], [u8; 32]) {
    let mut mac = <Blake2sMac<U32> as KeyInit>::new_from_slice(b"daak-keys").expect("32-byte key");
    mac.update(handshake_hash);
    let base: [u8; 32] = mac.finalize().into_bytes().into();
    let i2r = derive_key(&base, b"initiator-to-responder", 0);
    let r2i = derive_key(&base, b"responder-to-initiator", 0);
    if initiator {
        (i2r, r2i)
    } else {
        (r2i, i2r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directional_keys_are_mirrored() {
        let (a_tx, a_rx) = directional_keys(b"hash", true);
        let (b_tx, b_rx) = directional_keys(b"hash", false);
        assert_eq!(a_tx, b_rx);
        assert_eq!(a_rx, b_tx);
        assert_ne!(a_tx, a_rx);
    }

    #[test]
    fn rekey_changes_material() {
        let k0 = derive_key(&[1u8; 32], b"data", 0);
        let k1 = derive_key(&[1u8; 32], b"data", 1);
        assert_ne!(k0, k1);
    }

    #[test]
    fn info_separates_material() {
        assert_ne!(
            derive_key(&[1u8; 32], b"data", 0),
            derive_key(&[1u8; 32], b"other", 0)
        );
    }
}
