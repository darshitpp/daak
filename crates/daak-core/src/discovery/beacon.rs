use serde::{Deserialize, Serialize};

use crate::crypto::aead::{nonce, open, seal};
use crate::crypto::keys::derive_key;
use crate::discovery::presence::Presence;
use crate::error::{CoreError, Result};

/// Pairing-scoped control key for presence. Available with no live session.
pub fn pairing_presence_key(static_secret: &[u8; 32], peer_static: &[u8; 32]) -> [u8; 32] {
    let shared = x25519_dalek::StaticSecret::from(*static_secret)
        .diffie_hellman(&x25519_dalek::PublicKey::from(*peer_static));
    derive_key(shared.as_bytes(), b"daak-presence", 0)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SealedBeacon {
    pub v: u8,
    #[serde(with = "crate::manifest::byte_array")]
    pub device_id: [u8; 16],
    pub seq: u64,
    #[serde(with = "bytes")]
    pub body: Vec<u8>, // nonce(12) || ciphertext
}

// Serde encodes Vec<u8> as a CBOR array of integers. The schema wants a byte
// string. This module makes the CBOR bytes a bstr.
mod bytes {
    use std::fmt;

    use serde::de::{Error, Visitor};
    use serde::{Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bytes(value)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        struct V;

        impl<'de> Visitor<'de> for V {
            type Value = Vec<u8>;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a CBOR byte string")
            }

            fn visit_bytes<E: Error>(self, v: &[u8]) -> Result<Vec<u8>, E> {
                Ok(v.to_vec())
            }

            fn visit_byte_buf<E: Error>(self, v: Vec<u8>) -> Result<Vec<u8>, E> {
                Ok(v)
            }
        }

        deserializer.deserialize_bytes(V)
    }
}

impl SealedBeacon {
    pub fn seal(p: &Presence, key: &[u8; 32], seq: u64) -> Result<Self> {
        let n = nonce(0, seq);
        let aad = Self::aad(p.device_id, seq);
        let ct = seal(key, &n, &aad, &p.to_cbor()?)?;
        let mut body = n.to_vec();
        body.extend_from_slice(&ct);
        Ok(Self {
            v: 1,
            device_id: p.device_id,
            seq,
            body,
        })
    }

    pub fn open(&self, key: &[u8; 32]) -> Result<Presence> {
        if self.body.len() < 12 {
            return Err(CoreError::Protocol("short presence beacon".into()));
        }
        let (n, ct) = self.body.split_at(12);
        let n: [u8; 12] = n
            .try_into()
            .map_err(|_| CoreError::Protocol("bad nonce".into()))?;
        let aad = Self::aad(self.device_id, self.seq);
        let pt = open(key, &n, &aad, ct)?;
        Presence::from_cbor(&pt)
    }

    fn aad(device_id: [u8; 16], seq: u64) -> Vec<u8> {
        let mut a = b"daak-beacon".to_vec();
        a.extend_from_slice(&device_id);
        a.extend_from_slice(&seq.to_be_bytes());
        a
    }

    pub fn to_cbor(&self) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        ciborium::ser::into_writer(self, &mut out).map_err(|e| CoreError::Cbor(e.to_string()))?;
        Ok(out)
    }

    pub fn from_cbor(bytes: &[u8]) -> Result<Self> {
        ciborium::de::from_reader(bytes).map_err(|e| CoreError::Cbor(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::presence::{Presence, PresenceState};

    fn peer_pub(secret: [u8; 32]) -> [u8; 32] {
        x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(secret)).to_bytes()
    }

    #[test]
    fn sealed_beacon_roundtrips_and_rejects_tampering() {
        let local = [42u8; 32];
        let peer_pub = peer_pub([7u8; 32]);
        let key = pairing_presence_key(&local, &peer_pub);
        let p = Presence {
            device_id: [9u8; 16],
            session_id: [0u8; 16],
            name: "phone".into(),
            state: PresenceState::Online,
            seq: 3,
            sent_at_ms: 10,
        };
        let b = SealedBeacon::seal(&p, &key, 3).unwrap();
        assert_eq!(b.open(&key).unwrap(), p);

        let mut tampered = b.clone();
        let last = tampered.body.len() - 1;
        tampered.body[last] ^= 0xff;
        assert!(
            tampered.open(&key).is_err(),
            "tampered ciphertext must fail the AEAD tag"
        );

        let wrong = pairing_presence_key(&[1u8; 32], &peer_pub);
        assert!(b.open(&wrong).is_err(), "wrong pairing key must not open");
    }

    #[test]
    fn sealed_beacon_cbor_roundtrips() {
        let key = pairing_presence_key(&[3u8; 32], &peer_pub([4u8; 32]));
        let p = Presence {
            device_id: [1u8; 16],
            session_id: [0u8; 16],
            name: "n".into(),
            state: PresenceState::Away,
            seq: 1,
            sent_at_ms: 1,
        };
        let b = SealedBeacon::seal(&p, &key, 1).unwrap();
        let back = SealedBeacon::from_cbor(&b.to_cbor().unwrap()).unwrap();
        assert_eq!(back, b);
        assert_eq!(back.open(&key).unwrap(), p);
    }

    #[test]
    fn sealed_beacon_encodes_bstr_not_int_array() {
        let key = pairing_presence_key(&[5u8; 32], &peer_pub([6u8; 32]));
        let p = Presence {
            device_id: [2u8; 16],
            session_id: [0u8; 16],
            name: "n".into(),
            state: PresenceState::Online,
            seq: 1,
            sent_at_ms: 1,
        };
        let b = SealedBeacon::seal(&p, &key, 1).unwrap();
        let value: ciborium::value::Value =
            ciborium::de::from_reader(b.to_cbor().unwrap().as_slice()).unwrap();
        let map = value.as_map().expect("beacon is a map");
        for key_name in ["device_id", "body"] {
            let v = map
                .iter()
                .find(|(k, _)| k.as_text() == Some(key_name))
                .map(|(_, v)| v)
                .expect("field present");
            assert!(
                matches!(v, ciborium::value::Value::Bytes(_)),
                "{key_name} must be a CBOR byte string, not an int array"
            );
        }
    }
}
