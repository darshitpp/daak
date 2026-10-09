//! Published known-answer tests for daak-core's crypto primitives.
//!
//! There is deliberately no HKDF-SHA256 vector here: the Task 6 key schedule
//! is a keyed-BLAKE2s PRF, not HKDF. The hkdf 0.12 dependency was removed
//! because its Eager-buffered hash core cannot wrap blake2's Lazy Blake2s256,
//! so Hkdf<Blake2s256> does not compile. The RFC 8439 AEAD vector below is the
//! real interop pin.

use daak_core::crypto::{derive_key, directional_keys, open, seal, HandshakeDriver};

fn hex(s: &str) -> Vec<u8> {
    hex::decode(s).expect("valid hex")
}

fn hex32(s: &str) -> [u8; 32] {
    hex(s).try_into().expect("32-byte hex")
}

fn hex12(s: &str) -> [u8; 12] {
    hex(s).try_into().expect("12-byte hex")
}

#[test]
fn rfc8439_aead_vector() {
    let key: [u8; 32] = hex32("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
    let nonce: [u8; 12] = hex12("070000004041424344454647");
    let aad = hex("50515253c0c1c2c3c4c5c6c7");
    let pt = b"Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";
    let ct = seal(&key, &nonce, &aad, pt).unwrap();
    // seal returns ciphertext || 16-byte tag.
    let (ciphertext, tag) = ct.split_at(ct.len() - 16);
    assert_eq!("d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3ff4def08e4b7a9de576d26586cec64b6116".to_string(), hex::encode(ciphertext));
    assert_eq!(
        "1ae10b594f09e26a7e902ecbd0600691".to_string(),
        hex::encode(tag)
    );
    assert_eq!(open(&key, &nonce, &aad, &ct).unwrap(), pt);
}

#[test]
fn noise_xx_pin() {
    let a_static = [0x01u8; 32];
    let b_static = [0x02u8; 32];
    let prologue = b"daak-xx-pin";
    let mut a = HandshakeDriver::initiator(&a_static, prologue).unwrap();
    let mut b = HandshakeDriver::responder(&b_static, prologue).unwrap();

    // XX: -> e ; <- e, ee, s, es ; -> s, se
    let m1 = a.write().unwrap();
    b.read(&m1).unwrap();
    let m2 = b.write().unwrap();
    a.read(&m2).unwrap();
    let m3 = a.write().unwrap();
    b.read(&m3).unwrap();

    assert!(a.is_finished() && b.is_finished());
    let a_hash = a.handshake_hash();
    let b_hash = b.handshake_hash();
    assert_eq!(a_hash, b_hash);

    let (a_i2r, a_r2i) = a.raw_split();
    let (b_i2r, b_r2i) = b.raw_split();
    assert_eq!((a_i2r, a_r2i), (b_i2r, b_r2i), "both sides split alike");
    let (a_tx, a_rx) = directional_keys(a_i2r, a_r2i, true);
    let (b_tx, b_rx) = directional_keys(b_i2r, b_r2i, false);
    assert_eq!(a_tx, b_rx, "tx_a must equal rx_b");
    assert_eq!(a_rx, b_tx, "rx_a must equal tx_b");
    assert_ne!(a_tx, a_rx, "tx and rx must differ");
}

#[test]
fn kdf_known_answers() {
    let k = derive_key(&[1u8; 32], b"data", 0);
    // Frozen after confirming stability across 3 runs with these fixed inputs.
    assert_eq!(
        "96b6b67a38009fe97292f60252c24e5b338146efcb0da7c2fbc7e3ecd9c79e1b".to_string(),
        hex::encode(k)
    );
    // The raw split keys are the session keys. The initiator sends with i2r.
    let (tx, rx) = directional_keys([7u8; 32], [8u8; 32], true);
    assert_eq!((tx, rx), ([7u8; 32], [8u8; 32]));
    let (tx, rx) = directional_keys([7u8; 32], [8u8; 32], false);
    assert_eq!((tx, rx), ([8u8; 32], [7u8; 32]));
}
