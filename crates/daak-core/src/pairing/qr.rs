use serde::{Deserialize, Serialize};

use crate::crypto::identity::IdentityPublic;
use crate::error::{CoreError, Result};

pub const PAIRING_BUNDLE_VERSION: u16 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairingBundle {
    pub v: u16,
    pub identity: IdentityPublic,
    pub name: String,
    #[serde(with = "crate::manifest::byte_array")]
    pub nonce: [u8; 16],
}

impl PairingBundle {
    pub fn new(identity: IdentityPublic, name: String) -> Self {
        let mut nonce = [0u8; 16];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut nonce);
        Self {
            v: PAIRING_BUNDLE_VERSION,
            identity,
            name,
            nonce,
        }
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
    use crate::crypto::identity::Identity;

    #[test]
    fn bundle_roundtrips_and_rejects_tampered_identity() {
        let id = Identity::generate().unwrap();
        let b = PairingBundle::new(id.public(), "Phone".into());
        let back = PairingBundle::from_cbor(&b.to_cbor().unwrap()).unwrap();
        assert_eq!(b, back);
        assert!(crate::crypto::identity::verify_static_binding(
            &back.identity.ed25519,
            &back.identity.x25519,
            &back.identity.static_sig
        ));

        let mut tampered = back.clone();
        tampered.identity.x25519[0] ^= 0xFF;
        assert!(!crate::crypto::identity::verify_static_binding(
            &tampered.identity.ed25519,
            &tampered.identity.x25519,
            &tampered.identity.static_sig
        ));

        let mut tampered = back.clone();
        tampered.identity.static_sig[0] ^= 0xFF;
        assert!(!crate::crypto::identity::verify_static_binding(
            &tampered.identity.ed25519,
            &tampered.identity.x25519,
            &tampered.identity.static_sig
        ));
    }
}
