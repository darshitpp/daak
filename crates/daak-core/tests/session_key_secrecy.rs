//! A passive observer must not be able to compute the session keys.
//!
//! The observer sees the 3 handshake messages and knows the prologue (the two
//! static public keys). It holds no private key. The test rebuilds the Noise
//! handshake hash from those public bytes, then applies the old key derivation.
//! The session keys must differ from the result.

use blake2::digest::consts::U32;
use blake2::digest::{KeyInit, Mac};
use blake2::{Blake2s256, Blake2sMac, Digest};
use bytes::Bytes;
use daak_core::crypto::noise::{session_prologue, HandshakeDriver, NOISE_PARAMS};
use daak_core::framing::{Frame, RecordType};
use daak_core::net::secure::{complete_handshake, FrameTransport};
use daak_core::Result;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

struct Tap {
    out: mpsc::UnboundedSender<Frame>,
    inbox: mpsc::UnboundedReceiver<Frame>,
    wire: Arc<Mutex<Vec<Vec<u8>>>>,
}

impl FrameTransport for Tap {
    async fn send(&mut self, stream_id: u32, kind: RecordType, body: Bytes) -> Result<()> {
        self.wire.lock().unwrap().push(body.to_vec());
        self.out.send(Frame::new(stream_id, kind, body)).unwrap();
        Ok(())
    }
    async fn recv(&mut self) -> Result<Option<Frame>> {
        Ok(self.inbox.recv().await)
    }
}

fn mix(h: [u8; 32], data: &[u8]) -> [u8; 32] {
    let mut d = Blake2s256::new();
    d.update(h);
    d.update(data);
    d.finalize().into()
}

/// The Noise XX handshake hash, from public data only.
fn observer_hash(prologue: &[u8], m: &[Vec<u8>]) -> [u8; 32] {
    let mut h: [u8; 32] = Blake2s256::digest(NOISE_PARAMS.as_bytes()).into();
    h = mix(h, prologue);
    h = mix(h, &m[0][..32]); // -> e
    h = mix(h, &m[0][32..]); //    empty payload
    h = mix(h, &m[1][..32]); // <- e
    h = mix(h, &m[1][32..80]); //   s (encrypted)
    h = mix(h, &m[1][80..]); //     payload tag
    h = mix(h, &m[2][..48]); // -> s (encrypted)
    mix(h, &m[2][48..]) //          payload tag
}

/// The key derivation of `crypto::keys::directional_keys`, initiator side.
fn observer_keys(hash: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    let mut mac = <Blake2sMac<U32> as KeyInit>::new_from_slice(b"daak-keys").unwrap();
    mac.update(hash);
    let base: [u8; 32] = mac.finalize().into_bytes().into();
    let derive = |info: &[u8]| -> [u8; 32] {
        let mut mac = <Blake2sMac<U32> as KeyInit>::new_from_slice(&base).unwrap();
        mac.update(b"daak-kdf");
        mac.update(&0u64.to_be_bytes());
        mac.update(info);
        mac.finalize().into_bytes().into()
    };
    (
        derive(b"initiator-to-responder"),
        derive(b"responder-to-initiator"),
    )
}

#[tokio::test]
async fn passive_observer_cannot_compute_the_session_keys() {
    let a_static = [1u8; 32];
    let b_static = [2u8; 32];
    // Real X25519 public keys are not needed here. The prologue only has to
    // match on both sides.
    let prologue = session_prologue(&[7u8; 32], &[9u8; 32]);

    let (a_tx, b_rx) = mpsc::unbounded_channel();
    let (b_tx, a_rx) = mpsc::unbounded_channel();
    let wire = Arc::new(Mutex::new(Vec::new()));
    let mut a = Tap {
        out: a_tx,
        inbox: a_rx,
        wire: wire.clone(),
    };
    let mut b = Tap {
        out: b_tx,
        inbox: b_rx,
        wire: wire.clone(),
    };

    let da = HandshakeDriver::initiator(&a_static, &prologue).unwrap();
    let db = HandshakeDriver::responder(&b_static, &prologue).unwrap();
    let (ra, rb) = tokio::join!(
        complete_handshake(&mut a, da, true),
        complete_handshake(&mut b, db, false)
    );
    let (a_send, a_recv, a_hash, _) = ra.unwrap();
    let (b_send, b_recv, _, _) = rb.unwrap();
    assert_eq!(a_send, b_recv, "the peers must still agree on the keys");
    assert_eq!(a_recv, b_send, "the peers must still agree on the keys");

    let m = wire.lock().unwrap().clone();
    assert_eq!(m.len(), 3, "the handshake has 3 messages");
    let h = observer_hash(&prologue, &m);
    assert_eq!(
        h.as_slice(),
        a_hash.as_slice(),
        "the handshake hash is a function of public data only"
    );

    let (o_send, o_recv) = observer_keys(&h);
    assert_ne!(
        a_send, o_send,
        "the initiator send key must not be computable from the wire"
    );
    assert_ne!(
        a_recv, o_recv,
        "the initiator receive key must not be computable from the wire"
    );
}
