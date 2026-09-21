use spake2::{Ed25519Group, Identity as SpakeIdentity, Password, Spake2};

use crate::error::{CoreError, Result};

pub enum SpakeRole {
    A,
    B,
}

pub type SpakeState = Spake2<Ed25519Group>;

pub fn spake2_start(role: SpakeRole, code: &str) -> Result<(SpakeState, Vec<u8>)> {
    let id_a = SpakeIdentity::new(b"daak-initiator");
    let id_b = SpakeIdentity::new(b"daak-responder");
    let (state, msg) = match role {
        SpakeRole::A => {
            Spake2::<Ed25519Group>::start_a(&Password::new(code.as_bytes()), &id_a, &id_b)
        }
        SpakeRole::B => {
            Spake2::<Ed25519Group>::start_b(&Password::new(code.as_bytes()), &id_a, &id_b)
        }
    };
    Ok((state, msg))
}

pub fn spake2_finish(state: SpakeState, peer_msg: &[u8]) -> Result<[u8; 32]> {
    let key = state
        .finish(peer_msg)
        .map_err(|e| CoreError::Protocol(format!("spake2: {e}")))?;
    key.try_into()
        .map_err(|_| CoreError::Protocol("spake2: unexpected key length".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spake2_roles_derive_same_key() {
        let (a, msg_a) = spake2_start(SpakeRole::A, "123456").unwrap();
        let (b, msg_b) = spake2_start(SpakeRole::B, "123456").unwrap();
        let ka = spake2_finish(a, &msg_b).unwrap();
        let kb = spake2_finish(b, &msg_a).unwrap();
        assert_eq!(ka, kb);
    }

    #[test]
    fn spake2_mismatched_code_gives_different_keys() {
        let (a, msg_a) = spake2_start(SpakeRole::A, "111111").unwrap();
        let (b, msg_b) = spake2_start(SpakeRole::B, "222222").unwrap();
        let ka = spake2_finish(a, &msg_b).unwrap();
        let kb = spake2_finish(b, &msg_a).unwrap();
        assert_ne!(ka, kb);
    }
}
