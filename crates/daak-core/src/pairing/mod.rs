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

pub fn pairing_prologue(a: &PairingBundle, b: &PairingBundle) -> Result<Vec<u8>> {
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
    Ok(prologue)
}

pub async fn pair<T: FrameTransport>(
    conn: &mut T,
    identity: &Identity,
    local: &PairingBundle,
    expected: &PairingBundle,
    initiator: bool,
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
    let prologue = pairing_prologue(local, expected)?;
    let static_secret = zeroize::Zeroizing::new(identity.static_secret().to_bytes());
    let driver = if initiator {
        HandshakeDriver::initiator(&static_secret, &prologue)?
    } else {
        HandshakeDriver::responder(&static_secret, &prologue)?
    };
    let (_tx, _rx, hash) = crate::net::secure::complete_handshake(conn, driver, initiator).await?;
    crate::net::secure::confirm_keys(conn, &hash, initiator).await?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prologue_is_order_independent() {
        let a = PairingBundle::new(
            crate::crypto::identity::Identity::generate()
                .unwrap()
                .public(),
            "A".into(),
        );
        let b = PairingBundle::new(
            crate::crypto::identity::Identity::generate()
                .unwrap()
                .public(),
            "B".into(),
        );
        assert_eq!(
            pairing_prologue(&a, &b).unwrap(),
            pairing_prologue(&b, &a).unwrap()
        );
    }
}
