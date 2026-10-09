// A peer that connects and then goes silent must not hold the handshake open
// forever. The handshake gets a deadline.

use bytes::Bytes;
use daak_core::crypto::noise::HandshakeDriver;
use daak_core::framing::{Frame, RecordType};
use daak_core::net::secure::{complete_handshake, FrameTransport};
use daak_core::Result;
use std::time::Duration;

struct Silent;

impl FrameTransport for Silent {
    async fn send(&mut self, _: u32, _: RecordType, _: Bytes) -> Result<()> {
        Ok(())
    }
    async fn recv(&mut self) -> Result<Option<Frame>> {
        std::future::pending().await
    }
}

#[tokio::test(start_paused = true)]
async fn a_silent_peer_times_out_of_the_handshake() {
    let driver = HandshakeDriver::responder(&[2u8; 32], b"p").unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(120),
        complete_handshake(&mut Silent, driver, false),
    )
    .await;
    let inner = result.expect("the handshake must give up before 120 s");
    assert!(inner.is_err(), "a silent peer is an error, not a success");
}
