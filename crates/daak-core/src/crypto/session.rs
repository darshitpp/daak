use std::time::Instant;

use crate::crypto::aead::{nonce, open, seal};
use crate::crypto::keys::{derive_key, REKEY_BYTES};
use crate::crypto::replay::ReplayWindow;
use crate::error::{CoreError, Result};
use crate::framing::RecordType;

/// Rotate the send epoch after 24h of wall-clock time even when fewer than
/// REKEY_BYTES have flowed, so an idle long-lived connection keeps rotating
/// keys. The peer follows via the Rekey signal (see net::secure).
pub const REKEY_SECONDS: u64 = 24 * 60 * 60;

/// Sentinel for an unused slot in old_epochs; real epochs are far below this.
const EMPTY_EPOCH: u32 = u32::MAX;

pub struct SecureSession {
    send_key: [u8; 32],
    recv_key: [u8; 32],
    send_counter: u64,
    sent_bytes: u64,
    epoch: u32,
    recv: ReplayWindow,
    last_rekey_at: Instant,
    /// The two most recently retired receive-epoch keys, kept so frames sealed
    /// under a retired epoch still decrypt while in flight.
    old_epochs: [(u32, [u8; 32]); 2],
}

impl SecureSession {
    pub fn new(send_key: [u8; 32], recv_key: [u8; 32]) -> Self {
        Self {
            send_key,
            recv_key,
            send_counter: 0,
            sent_bytes: 0,
            epoch: 0,
            recv: ReplayWindow::new(4096),
            last_rekey_at: Instant::now(),
            old_epochs: [(EMPTY_EPOCH, [0u8; 32]); 2],
        }
    }

    pub fn epoch(&self) -> u32 {
        self.epoch
    }

    pub fn aad(stream_id: u32, kind: RecordType, counter: u64, epoch: u32) -> Vec<u8> {
        let mut a = Vec::with_capacity(17);
        a.extend_from_slice(&stream_id.to_be_bytes());
        a.push(kind as u8);
        a.extend_from_slice(&counter.to_be_bytes());
        a.extend_from_slice(&epoch.to_be_bytes());
        a
    }

    /// True if sealing next_len more plaintext bytes will retire the current
    /// send epoch (bytes threshold crossed, or the time threshold elapsed).
    pub fn will_rekey(&self, next_len: u64) -> bool {
        self.sent_bytes.saturating_add(next_len) >= REKEY_BYTES
            || self.last_rekey_at.elapsed().as_secs() >= REKEY_SECONDS
    }

    /// Seal under the CURRENT epoch without advancing it. The Rekey signal must
    /// use this: the peer can only read a frame sealed with an epoch it already
    /// knows, while the caller's data frame that follows uses the new epoch.
    pub fn seal_current(
        &mut self,
        stream_id: u32,
        kind: RecordType,
        plaintext: &[u8],
    ) -> Result<Vec<u8>> {
        self.seal(stream_id, kind, plaintext)
    }

    fn seal(&mut self, stream_id: u32, kind: RecordType, plaintext: &[u8]) -> Result<Vec<u8>> {
        let counter = self.send_counter;
        let key = derive_key(&self.send_key, b"data", self.epoch as u64);
        let n = nonce(self.epoch, counter);
        let aad = Self::aad(stream_id, kind, counter, self.epoch);
        let ct = seal(&key, &n, &aad, plaintext)?;
        self.send_counter += 1;
        // Wire body = counter (8 bytes, big-endian) || ciphertext. The receiver
        // needs the counter before it can build the nonce, and the counter is
        // authenticated because it is also part of the AAD.
        let mut out = Vec::with_capacity(8 + ct.len());
        out.extend_from_slice(&counter.to_be_bytes());
        out.extend_from_slice(&ct);
        Ok(out)
    }

    pub fn encrypt(
        &mut self,
        stream_id: u32,
        kind: RecordType,
        plaintext: &[u8],
    ) -> Result<Vec<u8>> {
        // Bump BEFORE sealing so this frame is the first of the new epoch;
        // send_counter never resets, keeping nonces unique across epochs.
        if self.will_rekey(plaintext.len() as u64) {
            self.epoch += 1;
            self.sent_bytes = 0;
            self.last_rekey_at = Instant::now();
        }
        let out = self.seal(stream_id, kind, plaintext)?;
        self.sent_bytes += plaintext.len() as u64;
        Ok(out)
    }

    /// Advance the receive epoch to new_epoch, retaining the retiring epoch's
    /// key (and the one before it) so old-epoch frames still decrypt.
    pub fn advance_recv_epoch(&mut self, new_epoch: u32) -> Result<()> {
        if new_epoch <= self.epoch {
            return Err(CoreError::Protocol("stale rekey epoch".into()));
        }
        let retiring = derive_key(&self.recv_key, b"data", self.epoch as u64);
        self.old_epochs[0] = self.old_epochs[1];
        self.old_epochs[1] = (self.epoch, retiring);
        self.epoch = new_epoch;
        Ok(())
    }

    pub fn decrypt(&mut self, stream_id: u32, kind: RecordType, body: &[u8]) -> Result<Vec<u8>> {
        if body.len() < 8 {
            return Err(CoreError::Protocol(
                "encrypted frame shorter than counter".into(),
            ));
        }
        let counter = u64::from_be_bytes(body[..8].try_into().unwrap());
        // Authenticate first, mark the replay window only on success (Ruling A):
        // a forged frame must never advance the window past legitimate traffic.
        // The 4-byte epoch is in the nonce/AAD, so try the current epoch then the
        // two retained old epochs; open succeeds only with the matching key.
        let candidates = [self.epoch, self.old_epochs[0].0, self.old_epochs[1].0];
        for epoch in candidates {
            if epoch == EMPTY_EPOCH {
                continue;
            }
            let key = derive_key(&self.recv_key, b"data", epoch as u64);
            let n = nonce(epoch, counter);
            let aad = Self::aad(stream_id, kind, counter, epoch);
            let Ok(pt) = open(&key, &n, &aad, &body[8..]) else {
                continue;
            };
            if !self.recv.accept(counter) {
                return Err(CoreError::Protocol("replayed or stale frame".into()));
            }
            return Ok(pt);
        }
        Err(CoreError::Protocol("aead open failed".into()))
    }

    #[cfg(test)]
    pub fn force_sent_bytes(&mut self, n: u64) {
        self.sent_bytes = n;
    }

    #[cfg(test)]
    pub fn force_last_rekey(&mut self, t: Instant) {
        self.last_rekey_at = t;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::ControlMsg;

    #[test]
    fn rekey_after_one_gibibyte() {
        let mut s = SecureSession::new([1u8; 32], [2u8; 32]);
        s.force_sent_bytes(REKEY_BYTES);
        let before = s.epoch();
        s.encrypt(0, RecordType::Chunk, &[0u8; 8]).unwrap();
        assert_eq!(s.epoch(), before + 1);
    }

    #[test]
    fn rekey_after_twenty_four_hours() {
        let mut s = SecureSession::new([1u8; 32], [2u8; 32]);
        s.force_last_rekey(
            std::time::Instant::now() - std::time::Duration::from_secs(24 * 60 * 60 + 1),
        );
        let before = s.epoch();
        s.encrypt(0, RecordType::Chunk, &[0u8; 8]).unwrap();
        assert_eq!(s.epoch(), before + 1);
    }

    #[test]
    fn rekey_signal_advances_the_receiver() {
        let tx = [1u8; 32];
        let rx = [2u8; 32];
        let mut sender = SecureSession::new(tx, rx);
        let mut receiver = SecureSession::new(rx, tx);

        // A frame sealed under the retiring epoch must still decrypt after the
        // receiver advances (old-epoch retention).
        let old_frame = sender.seal_current(3, RecordType::Chunk, b"old").unwrap();

        // Force a send-side rekey and emit the signal exactly as
        // SecureConnection::send does: sealed under the retiring epoch, stream 0.
        sender.force_sent_bytes(REKEY_BYTES);
        let rekey = ControlMsg::Rekey {
            epoch: sender.epoch() + 1,
        };
        let rekey_frame = sender
            .seal_current(0, RecordType::Rekey, &rekey.to_cbor().unwrap())
            .unwrap();

        // The data frame that follows the signal uses the new epoch.
        let new_frame = sender.encrypt(3, RecordType::Chunk, b"new").unwrap();

        // (a) Before seeing the REKEY frame the receiver cannot open new-epoch data.
        assert!(receiver.decrypt(3, RecordType::Chunk, &new_frame).is_err());

        // (b) Process the REKEY frame (as SecureConnection::recv does), then the
        // receiver follows the new epoch.
        let pt = receiver
            .decrypt(0, RecordType::Rekey, &rekey_frame)
            .unwrap();
        let ControlMsg::Rekey { epoch } = ControlMsg::from_cbor(&pt).unwrap() else {
            panic!("a rekey frame must hold a Rekey message");
        };
        assert_eq!(epoch, 1);
        receiver.advance_recv_epoch(epoch).unwrap();

        assert_eq!(
            receiver.decrypt(3, RecordType::Chunk, &new_frame).unwrap(),
            b"new"
        );

        // Old-epoch frame still decrypts (retention).
        assert_eq!(
            receiver.decrypt(3, RecordType::Chunk, &old_frame).unwrap(),
            b"old"
        );
    }
}
