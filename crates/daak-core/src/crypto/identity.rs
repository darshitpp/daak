use base32::Alphabet;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::error::{CoreError, Result};

use super::secret_store::SecretStore;

pub const STATIC_SIGN_CONTEXT: &[u8] = b"daak-static";
const STORE_SIGNING: &str = "identity.ed25519.signing";
const STORE_STATIC: &str = "identity.x25519.static";

pub struct Identity {
    signing: SigningKey,
    verify: VerifyingKey,
    static_secret: StaticSecret,
    static_public: PublicKey,
    static_sig: [u8; 64],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdentityPublic {
    #[serde(with = "crate::manifest::byte_array")]
    pub device_id: [u8; 16],
    #[serde(with = "crate::manifest::byte_array")]
    pub ed25519: [u8; 32],
    #[serde(with = "crate::manifest::byte_array")]
    pub x25519: [u8; 32],
    #[serde(with = "crate::manifest::byte_array")]
    pub static_sig: [u8; 64],
}

impl IdentityPublic {
    pub fn to_cbor(&self) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        ciborium::ser::into_writer(self, &mut out).map_err(|e| CoreError::Cbor(e.to_string()))?;
        Ok(out)
    }

    pub fn from_cbor(bytes: &[u8]) -> Result<Self> {
        ciborium::de::from_reader(bytes).map_err(|e| CoreError::Cbor(e.to_string()))
    }
}

fn static_message(x25519: &[u8; 32]) -> Vec<u8> {
    let mut m = Vec::with_capacity(STATIC_SIGN_CONTEXT.len() + 32);
    m.extend_from_slice(STATIC_SIGN_CONTEXT);
    m.extend_from_slice(x25519);
    m
}

impl Identity {
    pub fn generate() -> Result<Self> {
        let signing = SigningKey::generate(&mut OsRng);
        let verify = signing.verifying_key();
        let static_secret = StaticSecret::random_from_rng(OsRng);
        let static_public = PublicKey::from(&static_secret);
        let sig = signing
            .sign(&static_message(static_public.as_bytes()))
            .to_bytes();
        Ok(Self {
            signing,
            verify,
            static_secret,
            static_public,
            static_sig: sig,
        })
    }

    pub fn device_id(&self) -> [u8; 16] {
        let h = crate::hash::blake2b256(self.verify.as_bytes());
        h[..16].try_into().unwrap()
    }

    pub fn fingerprint(&self) -> String {
        let h = crate::hash::blake2b256(self.verify.as_bytes());
        let s = base32::encode(Alphabet::Rfc4648 { padding: false }, &h[..20]);
        s.as_bytes()
            .chunks(4)
            .map(|c| std::str::from_utf8(c).unwrap().to_string())
            .collect::<Vec<_>>()
            .join("-")
    }

    pub fn public(&self) -> IdentityPublic {
        IdentityPublic {
            device_id: self.device_id(),
            ed25519: self.verify.to_bytes(),
            x25519: *self.static_public.as_bytes(),
            static_sig: self.static_sig,
        }
    }

    pub fn static_secret(&self) -> &StaticSecret {
        &self.static_secret
    }

    pub fn signing_key(&self) -> &SigningKey {
        &self.signing
    }
}

pub fn verify_static_binding(ed25519: &[u8; 32], x25519: &[u8; 32], sig: &[u8; 64]) -> bool {
    let vk = match VerifyingKey::from_bytes(ed25519) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let s = Signature::from_bytes(sig);
    vk.verify_strict(&static_message(x25519), &s).is_ok()
}

pub fn import_from_store(store: &dyn SecretStore) -> Result<Identity> {
    let have_signing = store.get(STORE_SIGNING)?;
    let have_static = store.get(STORE_STATIC)?;
    match (have_signing, have_static) {
        (Some(sk), Some(st)) if sk.len() == 32 && st.len() == 32 => {
            let signing = SigningKey::from_bytes(sk.as_slice().try_into().unwrap());
            let verify = signing.verifying_key();
            let static_secret = StaticSecret::from(<[u8; 32]>::try_from(st.as_slice()).unwrap());
            let static_public = PublicKey::from(&static_secret);
            let static_sig = signing
                .sign(&static_message(static_public.as_bytes()))
                .to_bytes();
            Ok(Identity {
                signing,
                verify,
                static_secret,
                static_public,
                static_sig,
            })
        }
        (None, None) => {
            let id = Identity::generate()?;
            store.set(
                STORE_SIGNING,
                Zeroizing::new(id.signing.to_bytes().to_vec()).as_slice(),
            )?;
            store.set(
                STORE_STATIC,
                Zeroizing::new(id.static_secret.to_bytes().to_vec()).as_slice(),
            )?;
            Ok(id)
        }
        _ => Err(CoreError::Protocol(
            "corrupt identity: signing and static keys must both exist".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::secret_store::MemorySecretStore;

    #[test]
    fn device_id_is_stable_and_16_bytes() {
        let id = Identity::generate().unwrap();
        assert_eq!(id.device_id().len(), 16);
        assert_eq!(id.device_id(), id.device_id());
    }

    #[test]
    fn static_binding_verifies_for_owner_and_fails_for_tamper() {
        let id = Identity::generate().unwrap();
        let p = id.public();
        assert!(verify_static_binding(&p.ed25519, &p.x25519, &p.static_sig));

        let mut bad_sig = p.static_sig;
        bad_sig[0] ^= 0xFF;
        assert!(!verify_static_binding(&p.ed25519, &p.x25519, &bad_sig));

        let mut bad_pub = p.x25519;
        bad_pub[0] ^= 0xFF;
        assert!(!verify_static_binding(&p.ed25519, &bad_pub, &p.static_sig));
    }

    #[test]
    fn fingerprint_is_grouped_base32() {
        let id = Identity::generate().unwrap();
        let fp = id.fingerprint();
        assert!(fp.contains('-'), "fingerprint should be grouped: {fp}");
        assert!(fp.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    }

    #[test]
    fn identity_persists_across_reloads() {
        let store = MemorySecretStore::default();
        let a = import_from_store(&store).unwrap();
        let b = import_from_store(&store).unwrap();
        assert_eq!(a.device_id(), b.device_id());
        assert_eq!(a.public(), b.public());
    }

    #[test]
    fn public_identity_roundtrips_as_cbor_byte_strings() {
        let id = Identity::generate().unwrap();
        let p = id.public();
        let bytes = p.to_cbor().unwrap();
        assert_eq!(IdentityPublic::from_cbor(&bytes).unwrap(), p);

        let v: ciborium::Value = ciborium::from_reader(&bytes[..]).unwrap();
        let map = v
            .as_map()
            .expect("IdentityPublic should encode as a CBOR map");
        let check = |name: &str, want_len: usize| {
            let found = map
                .iter()
                .find(|(k, _)| k.as_text() == Some(name))
                .unwrap_or_else(|| panic!("missing field {name}"));
            let field = &found.1;
            match field {
                ciborium::Value::Bytes(b) => {
                    assert_eq!(b.len(), want_len, "field {name} length")
                }
                other => panic!("field {name} is {other:?}, expected a byte string"),
            }
        };
        check("device_id", 16);
        check("ed25519", 32);
        check("x25519", 32);
        check("static_sig", 64);
    }
}
