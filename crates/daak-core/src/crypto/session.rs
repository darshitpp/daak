use crate::crypto::aead::{nonce, open, seal};
use crate::crypto::keys::{derive_key, REKEY_BYTES};
use crate::crypto::replay::ReplayWindow;
use crate::error::Result;
use crate::framing::RecordType;

pub struct SecureSession {
    send_key: [u8; 32],
    recv_key: [u8; 32],
    send_counter: u64,
    sent_bytes: u64,
    epoch: u32,
    recv: ReplayWindow,
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
        }
    }

    pub fn aad(stream_id: u32, kind: RecordType, counter: u64, epoch: u32) -> Vec<u8> {
        let mut a = Vec::with_capacity(17);
        a.extend_from_slice(&stream_id.to_be_bytes());
        a.push(kind as u8);
        a.extend_from_slice(&counter.to_be_bytes());
        a.extend_from_slice(&epoch.to_be_bytes());
        a
    }

    pub fn encrypt(
        &mut self,
        stream_id: u32,
        kind: RecordType,
        plaintext: &[u8],
    ) -> Result<Vec<u8>> {
        let counter = self.send_counter;
        let key = derive_key(&self.send_key, b"data", self.epoch as u64);
        let n = nonce(self.epoch, counter);
        let aad = Self::aad(stream_id, kind, counter, self.epoch);
        let ct = seal(&key, &n, &aad, plaintext)?;
        self.send_counter += 1;
        self.sent_bytes += plaintext.len() as u64;
        if self.sent_bytes >= REKEY_BYTES {
            self.epoch += 1;
            self.sent_bytes = 0;
        }
        // Wire body = counter (8 bytes, big-endian) || ciphertext. The receiver
        // needs the counter before it can build the nonce, and the counter is
        // authenticated because it is also part of the AAD.
        let mut out = Vec::with_capacity(8 + ct.len());
        out.extend_from_slice(&counter.to_be_bytes());
        out.extend_from_slice(&ct);
        Ok(out)
    }

    pub fn decrypt(&mut self, stream_id: u32, kind: RecordType, body: &[u8]) -> Result<Vec<u8>> {
        if body.len() < 8 {
            return Err(crate::CoreError::Protocol(
                "encrypted frame shorter than counter".into(),
            ));
        }
        let counter = u64::from_be_bytes(body[..8].try_into().unwrap());
        // Authenticate first, mark the replay window only on success (Ruling A):
        // a forged frame must never advance the window past legitimate traffic.
        let key = derive_key(&self.recv_key, b"data", self.epoch as u64);
        let n = nonce(self.epoch, counter);
        let aad = Self::aad(stream_id, kind, counter, self.epoch);
        let pt = open(&key, &n, &aad, &body[8..])?;
        if !self.recv.accept(counter) {
            return Err(crate::CoreError::Protocol("replayed or stale frame".into()));
        }
        Ok(pt)
    }
}
