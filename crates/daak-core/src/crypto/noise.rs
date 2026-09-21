use snow::{params::NoiseParams, Builder, HandshakeState, TransportState};

use crate::error::{CoreError, Result};

pub const NOISE_PARAMS: &str = "Noise_XX_25519_ChaChaPoly_BLAKE2s";

pub const SESSION_PROLOGUE_LABEL: &[u8] = b"daak-session";

pub fn session_prologue(a_static: &[u8; 32], b_static: &[u8; 32]) -> Vec<u8> {
    let (x, y) = if a_static <= b_static {
        (a_static, b_static)
    } else {
        (b_static, a_static)
    };
    let mut p = SESSION_PROLOGUE_LABEL.to_vec();
    p.extend_from_slice(x);
    p.extend_from_slice(y);
    p
}

fn params() -> Result<NoiseParams> {
    NOISE_PARAMS
        .parse()
        .map_err(|e: snow::Error| CoreError::Protocol(format!("noise params: {e}")))
}

pub struct HandshakeDriver {
    state: HandshakeState,
}

impl HandshakeDriver {
    fn build(initiator: bool, static_secret: &[u8; 32], prologue: &[u8]) -> Result<Self> {
        let builder = Builder::new(params()?)
            .local_private_key(static_secret)
            .prologue(prologue);
        let state = if initiator {
            builder.build_initiator()
        } else {
            builder.build_responder()
        }
        .map_err(|e| CoreError::Protocol(format!("noise build: {e}")))?;
        Ok(Self { state })
    }

    pub fn initiator(static_secret: &[u8; 32], prologue: &[u8]) -> Result<Self> {
        Self::build(true, static_secret, prologue)
    }

    pub fn responder(static_secret: &[u8; 32], prologue: &[u8]) -> Result<Self> {
        Self::build(false, static_secret, prologue)
    }

    pub fn write(&mut self) -> Result<Vec<u8>> {
        let mut buf = vec![0u8; 65535];
        let n = self
            .state
            .write_message(&[], &mut buf)
            .map_err(|e| CoreError::Protocol(format!("noise write: {e}")))?;
        buf.truncate(n);
        Ok(buf)
    }

    pub fn read(&mut self, msg: &[u8]) -> Result<()> {
        let mut buf = vec![0u8; 65535];
        self.state
            .read_message(msg, &mut buf)
            .map_err(|e| CoreError::Protocol(format!("noise read: {e}")))?;
        Ok(())
    }

    pub fn is_finished(&self) -> bool {
        self.state.is_handshake_finished()
    }

    pub fn handshake_hash(&self) -> Vec<u8> {
        self.state.get_handshake_hash().to_vec()
    }

    /// Finishes the handshake and returns the Noise transport plus the handshake
    /// hash. Directional keys are derived from this hash (Task 6), because snow
    /// does not expose its raw `split()` key material.
    pub fn into_transport(self) -> Result<(TransportState, Vec<u8>)> {
        let hash = self.state.get_handshake_hash().to_vec();
        let transport = self
            .state
            .into_transport_mode()
            .map_err(|e| CoreError::Protocol(format!("noise transport: {e}")))?;
        Ok((transport, hash))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xx_handshake_completes_and_hashes_match() {
        let a_static = [1u8; 32];
        let b_static = [2u8; 32];
        let mut a = HandshakeDriver::initiator(&a_static, b"prologue").unwrap();
        let mut b = HandshakeDriver::responder(&b_static, b"prologue").unwrap();

        // XX: -> e ; <- e, ee, s, es ; -> s, se
        let m1 = a.write().unwrap();
        b.read(&m1).unwrap();
        let m2 = b.write().unwrap();
        a.read(&m2).unwrap();
        let m3 = a.write().unwrap();
        b.read(&m3).unwrap();

        assert!(a.is_finished() && b.is_finished());
        assert_eq!(a.handshake_hash(), b.handshake_hash());

        let (a_t, a_hash) = a.into_transport().unwrap();
        let (b_t, b_hash) = b.into_transport().unwrap();
        drop((a_t, b_t));
        assert_eq!(
            a_hash, b_hash,
            "both sides must derive the same handshake hash"
        );
    }

    #[test]
    fn mismatched_prologue_breaks_the_handshake() {
        let mut a = HandshakeDriver::initiator(&[1u8; 32], b"prologue-a").unwrap();
        let mut b = HandshakeDriver::responder(&[2u8; 32], b"prologue-b").unwrap();
        // XX: -> e ; <- e, ee, s, es ; -> s, se
        let broken = (|| -> Result<()> {
            let m1 = a.write()?;
            b.read(&m1)?;
            let m2 = b.write()?;
            a.read(&m2)?;
            let m3 = a.write()?;
            b.read(&m3)
        })()
        .is_err()
            || a.handshake_hash() != b.handshake_hash();
        assert!(broken, "mismatched prologue must break the handshake");
    }

    #[test]
    fn session_prologue_is_order_independent() {
        let a = [1u8; 32];
        let b = [2u8; 32];
        assert_eq!(session_prologue(&a, &b), session_prologue(&b, &a));
        assert!(session_prologue(&a, &b).starts_with(SESSION_PROLOGUE_LABEL));
    }
}
