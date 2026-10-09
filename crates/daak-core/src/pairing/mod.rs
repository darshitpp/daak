pub mod code;
pub mod qr;

use crate::crypto::identity::{verify_static_binding, Identity};
use crate::crypto::noise::HandshakeDriver;
use crate::crypto::sas::sas_from_handshake_hash;
use crate::error::{CoreError, Result};
use crate::manifest::now_ms;
use crate::net::secure::FrameTransport;
use crate::store::pairings::Pairing;

pub use qr::PairingBundle;

use crate::framing::RecordType;
use bytes::Bytes;
use code::{spake2_finish, spake2_start, SpakeRole};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairMode {
    Qr,
    Code,
}

pub fn pairing_prologue(
    a: &PairingBundle,
    b: &PairingBundle,
    spake_key: Option<&[u8; 32]>,
) -> Result<Vec<u8>> {
    let (first, second) = if a.identity.device_id <= b.identity.device_id {
        (a, b)
    } else {
        (b, a)
    };
    let mut prologue = Vec::new();
    ciborium::ser::into_writer(
        &(
            "daak",
            first.identity.device_id,
            second.identity.device_id,
            first.identity.x25519,
            second.identity.x25519,
        ),
        &mut prologue,
    )
    .map_err(|e| CoreError::Cbor(e.to_string()))?;
    if let Some(k) = spake_key {
        prologue.extend_from_slice(b"|spake2|");
        prologue.extend_from_slice(k);
    }
    Ok(prologue)
}

pub async fn pair<T: FrameTransport>(
    conn: &mut T,
    identity: &Identity,
    local: &PairingBundle,
    expected: &PairingBundle,
    initiator: bool,
    mode: PairMode,
    code: Option<&str>,
) -> Result<(Pairing, String)> {
    if !verify_static_binding(
        &expected.identity.ed25519,
        &expected.identity.x25519,
        &expected.identity.static_sig,
    ) {
        return Err(CoreError::Protocol(
            "pairing bundle identity binding failed".into(),
        ));
    }
    if expected.identity.device_id == local.identity.device_id {
        return Err(CoreError::Protocol(
            "cannot pair a device with itself".into(),
        ));
    }
    // Manual-code pairing binds the SPAKE2 secret into the Noise prologue. QR
    // mode has no code exchange, so the prologue gets None (behaviour unchanged).
    let spake_key = match mode {
        PairMode::Qr => None,
        PairMode::Code => {
            let code = code.ok_or_else(|| {
                CoreError::Protocol("spake2 code required for code pairing".into())
            })?;
            let role = if initiator {
                SpakeRole::A
            } else {
                SpakeRole::B
            };
            let (state, msg) = spake2_start(role, code)?;
            let peer_msg = if initiator {
                conn.send(0, RecordType::Control, Bytes::from(msg)).await?;
                recv_control(conn).await?
            } else {
                let peer = recv_control(conn).await?;
                conn.send(0, RecordType::Control, Bytes::from(msg)).await?;
                peer
            };
            Some(spake2_finish(state, &peer_msg)?)
        }
    };
    let prologue = pairing_prologue(local, expected, spake_key.as_ref())?;
    let static_secret = zeroize::Zeroizing::new(identity.static_secret().to_bytes());
    let driver = if initiator {
        HandshakeDriver::initiator(&static_secret, &prologue)?
    } else {
        HandshakeDriver::responder(&static_secret, &prologue)?
    };
    let (_tx, _rx, hash, confirm_key) =
        crate::net::secure::complete_handshake(conn, driver, initiator).await?;
    crate::net::secure::confirm_keys(conn, &hash, &confirm_key, initiator).await?;
    let sas = sas_from_handshake_hash(&hash);
    let pairing = Pairing {
        peer_device_id: expected.identity.device_id,
        state: "trusted".into(),
        paired_at: now_ms() as i64 / 1000,
        verify_key: expected.identity.ed25519,
        static_dh_pub: expected.identity.x25519,
        label: Some(expected.name.clone()),
    };
    Ok((pairing, sas))
}

async fn recv_control<T: FrameTransport>(conn: &mut T) -> Result<Vec<u8>> {
    loop {
        match conn.recv().await? {
            Some(f) if f.kind == RecordType::Control => return Ok(f.body.to_vec()),
            Some(_) => continue,
            None => {
                return Err(CoreError::Protocol(
                    "connection closed during spake2 exchange".into(),
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::code::{spake2_finish, spake2_start, SpakeRole};
    use super::*;
    use crate::crypto::identity::Identity;

    #[test]
    fn prologue_is_order_independent() {
        let a = PairingBundle::new(Identity::generate().unwrap().public(), "A".into());
        let b = PairingBundle::new(Identity::generate().unwrap().public(), "B".into());
        assert_eq!(
            pairing_prologue(&a, &b, None).unwrap(),
            pairing_prologue(&b, &a, None).unwrap()
        );
    }

    #[tokio::test]
    async fn code_mode_mixes_spake2_into_the_prologue() {
        let (state_a, msg_a) = spake2_start(SpakeRole::A, "123456").unwrap();
        let (state_b, msg_b) = spake2_start(SpakeRole::B, "123456").unwrap();
        let key_a = spake2_finish(state_a, &msg_b).unwrap();
        let key_b = spake2_finish(state_b, &msg_a).unwrap();
        assert_eq!(key_a, key_b, "same code must derive the same SPAKE2 secret");

        let a = PairingBundle::new(Identity::generate().unwrap().public(), "a".into());
        let b = PairingBundle::new(Identity::generate().unwrap().public(), "b".into());
        assert_ne!(
            pairing_prologue(&a, &b, None).unwrap(),
            pairing_prologue(&a, &b, Some(&key_a)).unwrap(),
            "SPAKE2 key must change the prologue"
        );
    }
}
