use bytes::Bytes;
use std::path::{Path, PathBuf};
use subtle::ConstantTimeEq;
use tokio::io::{AsyncRead, AsyncWrite};

use crate::control::Hello;
use crate::crypto::noise::session_prologue;
use crate::crypto::noise::HandshakeDriver;
use crate::crypto::session::SecureSession;
use crate::error::Result;
use crate::framing::{Frame, RecordType};
use crate::manifest::Manifest;
use crate::transfer::{receive_transfer, send_transfer};

use super::connection::Connection;

pub trait FrameTransport {
    fn send(
        &mut self,
        stream_id: u32,
        kind: RecordType,
        body: Bytes,
    ) -> impl std::future::Future<Output = Result<()>> + Send;
    fn recv(&mut self) -> impl std::future::Future<Output = Result<Option<Frame>>> + Send;
}

impl<S: AsyncRead + AsyncWrite + Unpin + Send> FrameTransport for Connection<S> {
    async fn send(&mut self, stream_id: u32, kind: RecordType, body: Bytes) -> Result<()> {
        Connection::send(self, stream_id, kind, body).await
    }
    async fn recv(&mut self) -> Result<Option<Frame>> {
        Connection::recv(self).await
    }
}

/// Lets `&mut T` be used anywhere a `FrameTransport` is expected, so callers can
/// pass `&mut conn` to `send_transfer`/`receive_transfer`.
impl<T: FrameTransport + Send + ?Sized> FrameTransport for &mut T {
    async fn send(&mut self, stream_id: u32, kind: RecordType, body: Bytes) -> Result<()> {
        (**self).send(stream_id, kind, body).await
    }
    async fn recv(&mut self) -> Result<Option<Frame>> {
        (**self).recv().await
    }
}

pub async fn complete_handshake<T: FrameTransport>(
    conn: &mut T,
    mut driver: HandshakeDriver,
    initiator: bool,
) -> Result<([u8; 32], [u8; 32], Vec<u8>)> {
    if initiator {
        let m1 = driver.write()?;
        conn.send(0, RecordType::Handshake, Bytes::from(m1)).await?;
        let m2 = recv_handshake(conn).await?;
        driver.read(&m2)?;
        let m3 = driver.write()?;
        conn.send(0, RecordType::Handshake, Bytes::from(m3)).await?;
    } else {
        let m1 = recv_handshake(conn).await?;
        driver.read(&m1)?;
        let m2 = driver.write()?;
        conn.send(0, RecordType::Handshake, Bytes::from(m2)).await?;
        let m3 = recv_handshake(conn).await?;
        driver.read(&m3)?;
    }
    let hash = driver.handshake_hash();
    let (tx, rx) = crate::crypto::keys::directional_keys(&hash, initiator);
    Ok((tx, rx, hash))
}

/// Explicit key confirmation (spec §3.5): both sides exchange
/// `HMAC-BLAKE2b(handshake_hash, "daak-confirm")` and abort on mismatch.
pub async fn confirm_keys<T: FrameTransport>(
    conn: &mut T,
    hash: &[u8],
    initiator: bool,
) -> Result<()> {
    let tag = confirm_tag(hash);
    let peer = if initiator {
        conn.send(0, RecordType::Control, Bytes::copy_from_slice(&tag))
            .await?;
        recv_control(conn).await?
    } else {
        let peer = recv_control(conn).await?;
        conn.send(0, RecordType::Control, Bytes::copy_from_slice(&tag))
            .await?;
        peer
    };
    // Constant-time compare (Ruling B); keep the length check because ct_eq on
    // slices of unequal length is not a constant-time comparison of the tag.
    if peer.len() != tag.len() || peer.ct_eq(&tag).unwrap_u8() != 1 {
        return Err(crate::CoreError::Protocol(
            "key confirmation mismatch".into(),
        ));
    }
    Ok(())
}

fn confirm_tag(hash: &[u8]) -> [u8; 32] {
    use blake2::digest::consts::U32;
    use blake2::digest::{KeyInit, Mac};
    use blake2::Blake2bMac;
    let mut mac = <Blake2bMac<U32> as KeyInit>::new_from_slice(b"daak-confirm")
        .expect("32-byte key for 32-byte tag");
    mac.update(hash);
    mac.finalize().into_bytes().into()
}

async fn recv_control<T: FrameTransport>(conn: &mut T) -> Result<Vec<u8>> {
    loop {
        match conn.recv().await? {
            Some(f) if f.kind == RecordType::Control => return Ok(f.body.to_vec()),
            Some(_) => continue,
            None => {
                return Err(crate::CoreError::Protocol(
                    "connection closed during key confirmation".into(),
                ))
            }
        }
    }
}

async fn recv_handshake<T: FrameTransport>(conn: &mut T) -> Result<Vec<u8>> {
    loop {
        match conn.recv().await? {
            Some(f) if f.kind == RecordType::Handshake => return Ok(f.body.to_vec()),
            Some(_) => continue,
            None => {
                return Err(crate::CoreError::Protocol(
                    "connection closed during handshake".into(),
                ))
            }
        }
    }
}

pub struct SecureConnection<T> {
    inner: T,
    session: SecureSession,
}

pub async fn send_secure_transfer<T: FrameTransport + Send>(
    conn: &mut T,
    static_secret: &[u8; 32],
    peer_static: &[u8; 32],
    device_id: [u8; 16],
    manifest: &Manifest,
    paths: &[Option<PathBuf>],
) -> Result<()> {
    let hello = Hello { device_id };
    conn.send(0, RecordType::Control, Bytes::from(hello.to_cbor()?))
        .await?;

    let prologue = session_prologue(&x25519_public(static_secret), peer_static);
    let driver = HandshakeDriver::initiator(static_secret, &prologue)?;
    let (tx, rx, _hash) = complete_handshake(conn, driver, true).await?;
    let mut secure = SecureConnection::new(conn, tx, rx);
    send_transfer(&mut secure, manifest, paths, |_| {}).await
}

pub async fn recv_secure_transfer<T: FrameTransport + Send>(
    conn: &mut T,
    static_secret: &[u8; 32],
    initiator_static: &[u8; 32],
    out_dir: &Path,
) -> Result<Manifest> {
    let prologue = session_prologue(&x25519_public(static_secret), initiator_static);
    let driver = HandshakeDriver::responder(static_secret, &prologue)?;
    let (tx, rx, _hash) = complete_handshake(conn, driver, false).await?;
    let mut secure = SecureConnection::new(conn, tx, rx);
    receive_transfer(&mut secure, out_dir, |_| {}).await
}

fn x25519_public(secret: &[u8; 32]) -> [u8; 32] {
    *x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(*secret)).as_bytes()
}

impl<T: FrameTransport> SecureConnection<T> {
    pub fn new(inner: T, send_key: [u8; 32], recv_key: [u8; 32]) -> Self {
        Self {
            inner,
            session: SecureSession::new(send_key, recv_key),
        }
    }

    pub fn encrypt(
        &mut self,
        kind: RecordType,
        stream_id: u32,
        plaintext: &[u8],
    ) -> Result<Vec<u8>> {
        self.session.encrypt(stream_id, kind, plaintext)
    }
}

impl<T: FrameTransport + Send> FrameTransport for SecureConnection<T> {
    async fn send(&mut self, stream_id: u32, kind: RecordType, body: Bytes) -> Result<()> {
        let ct = self.session.encrypt(stream_id, kind, &body)?;
        self.inner.send(stream_id, kind, Bytes::from(ct)).await
    }

    async fn recv(&mut self) -> Result<Option<Frame>> {
        match self.inner.recv().await? {
            Some(f) => {
                let pt = self.session.decrypt(f.stream_id, f.kind, &f.body)?;
                Ok(Some(Frame::new(f.stream_id, f.kind, Bytes::from(pt))))
            }
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::HandshakeDriver;
    use crate::framing::RecordType;
    use bytes::Bytes;
    use tokio::sync::mpsc;

    // In-memory FrameTransport pair for testing encryption without TCP.
    struct Chan {
        tx: mpsc::Sender<Frame>,
        rx: mpsc::Receiver<Frame>,
    }

    impl FrameTransport for Chan {
        async fn send(
            &mut self,
            stream_id: u32,
            kind: RecordType,
            body: Bytes,
        ) -> crate::Result<()> {
            self.tx
                .send(Frame::new(stream_id, kind, body))
                .await
                .map_err(|e| crate::CoreError::Protocol(e.to_string()))
        }
        async fn recv(&mut self) -> crate::Result<Option<Frame>> {
            Ok(self.rx.recv().await)
        }
    }

    fn channel_pair() -> (Chan, Chan) {
        let (a_tx, b_rx) = mpsc::channel(8);
        let (b_tx, a_rx) = mpsc::channel(8);
        (Chan { tx: a_tx, rx: a_rx }, Chan { tx: b_tx, rx: b_rx })
    }

    #[tokio::test]
    async fn encrypted_frames_roundtrip() {
        let (mut a_io, mut b_io) = channel_pair();
        let a_hs = HandshakeDriver::initiator(&[1u8; 32], b"p").unwrap();
        let b_hs = HandshakeDriver::responder(&[2u8; 32], b"p").unwrap();

        let (a_side, b_side) = tokio::join!(
            complete_handshake(&mut a_io, a_hs, true),
            complete_handshake(&mut b_io, b_hs, false),
        );
        let (a_tx, a_rx, _a_hash) = a_side.unwrap();
        let (b_tx, b_rx, _b_hash) = b_side.unwrap();

        // Mirrored directional keys: initiator's tx == responder's rx, and vice versa.
        let mut a = SecureConnection::new(a_io, a_tx, a_rx);
        let mut b = SecureConnection::new(b_io, b_tx, b_rx);

        a.send(7, RecordType::Chunk, Bytes::from_static(b"hello"))
            .await
            .unwrap();
        let f = b.recv().await.unwrap().unwrap();
        assert_eq!(f.stream_id, 7);
        assert_eq!(&f.body[..], b"hello");

        b.send(8, RecordType::Chunk, Bytes::from_static(b"world"))
            .await
            .unwrap();
        let f = a.recv().await.unwrap().unwrap();
        assert_eq!(f.stream_id, 8);
        assert_eq!(&f.body[..], b"world");

        // Sanity: sealing via the session produces ciphertext distinct from plaintext.
        let ct = a.encrypt(RecordType::Chunk, 0, b"hello").unwrap();
        assert_ne!(ct.as_slice(), b"hello".as_slice());
    }

    #[test]
    fn session_roundtrips_and_rejects_replay() {
        let tx = [1u8; 32];
        let rx = [2u8; 32];
        let mut a = SecureSession::new(tx, rx);
        let mut b = SecureSession::new(rx, tx);
        let ct = a.encrypt(1, RecordType::Chunk, b"hello").unwrap();
        assert_eq!(b.decrypt(1, RecordType::Chunk, &ct).unwrap(), b"hello");
        assert!(
            b.decrypt(1, RecordType::Chunk, &ct).is_err(),
            "replay must be rejected"
        );
    }
}
