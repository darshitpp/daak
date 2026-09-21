use blake2::digest::consts::U32;
use blake2::digest::KeyInit;
use blake2::digest::Mac;
use blake2::Blake2bMac;
use subtle::ConstantTimeEq;

const SAS_LABEL: &[u8] = b"daak-sas";

pub fn sas_from_handshake_hash(hash: &[u8]) -> String {
    let mut mac =
        <Blake2bMac<U32> as KeyInit>::new_from_slice(SAS_LABEL).expect("valid blake2b mac key");
    mac.update(hash);
    let out = mac.finalize().into_bytes();
    let n = u32::from_be_bytes([out[0], out[1], out[2], out[3]]) % 1_000_000;
    format!("{n:06}")
}

pub fn sas_matches(a: &str, b: &str) -> bool {
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sas_is_six_digits_and_deterministic() {
        let s = sas_from_handshake_hash(&[7u8; 64]);
        assert_eq!(s.len(), 6);
        assert!(s.chars().all(|c| c.is_ascii_digit()));
        assert_eq!(s, sas_from_handshake_hash(&[7u8; 64]));
    }

    #[test]
    fn different_hashes_give_different_sas() {
        assert_ne!(
            sas_from_handshake_hash(&[1u8; 64]),
            sas_from_handshake_hash(&[2u8; 64])
        );
    }

    #[test]
    fn matching_is_constant_time_and_correct() {
        assert!(sas_matches("123456", "123456"));
        assert!(!sas_matches("123456", "123457"));
    }
}
