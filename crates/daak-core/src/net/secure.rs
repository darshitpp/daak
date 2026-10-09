use bytes::Bytes;
use std::path::{Path, PathBuf};
use subtle::ConstantTimeEq;
use tokio::io::{AsyncRead, AsyncWrite};

use crate::control::{ControlMsg, Hello};
use crate::crypto::noise::session_prologue;
use crate::crypto::noise::HandshakeDriver;
use crate::crypto::session::SecureSession;
use crate::engine::EngineEvent;
use crate::error::Result;
use crate::framing::{Frame, RecordType};
use crate::manifest::Manifest;
use crate::store::Db;
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

/// Runs the Noise XX handshake. Returns the send key, the receive key, the
/// public handshake hash (the SAS input), and the secret key for `confirm_keys`.
pub async fn complete_handshake<T: FrameTransport>(
    conn: &mut T,
    mut driver: HandshakeDriver,
    initiator: bool,
) -> Result<([u8; 32], [u8; 32], Vec<u8>, [u8; 32])> {
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
    let (i2r, r2i) = driver.raw_split();
    let confirm_key = crate::crypto::keys::derive_key(&i2r, b"confirm", 0);
    let (tx, rx) = crate::crypto::keys::directional_keys(i2r, r2i, initiator);
    Ok((tx, rx, hash, confirm_key))
}

/// Explicit key confirmation (spec §3.5): both sides exchange
/// `keyed-BLAKE2s(key = confirm_key, message = "daak-confirm" || handshake_hash)`
/// and abort on mismatch. `confirm_key` comes from the secret split keys, so a
/// peer that did not complete the handshake cannot compute the tag.
pub async fn confirm_keys<T: FrameTransport>(
    conn: &mut T,
    hash: &[u8],
    confirm_key: &[u8; 32],
    initiator: bool,
) -> Result<()> {
    let tag = confirm_tag(confirm_key, hash);
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

fn confirm_tag(key: &[u8; 32], hash: &[u8]) -> [u8; 32] {
    use blake2::digest::consts::U32;
    use blake2::digest::{KeyInit, Mac};
    use blake2::Blake2sMac;
    let mut mac =
        <Blake2sMac<U32> as KeyInit>::new_from_slice(key).expect("32-byte key for 32-byte tag");
    mac.update(b"daak-confirm");
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
    let mut secure = open_secure(&mut *conn, static_secret, peer_static, device_id).await?;
    send_transfer(&mut secure, manifest, paths, &[], |_| {}).await
}

/// R-T11-6: the ONE initiator handshake (Hello -> Noise XX), factored out of
/// `send_secure_transfer` so the session registry's connect closure reuses it
/// instead of writing a second handshake. Takes the transport BY VALUE, so the
/// one-shot path passes `&mut *conn` and the registry passes an owned
/// `Connection<TcpStream>` and gets an owned `SecureConnection` back.
pub async fn open_secure<T: FrameTransport + Send>(
    mut conn: T,
    static_secret: &[u8; 32],
    peer_static: &[u8; 32],
    device_id: [u8; 16],
) -> Result<SecureConnection<T>> {
    let hello = Hello { device_id };
    conn.send(0, RecordType::Control, Bytes::from(hello.to_cbor()?))
        .await?;

    let prologue = session_prologue(&x25519_public(static_secret), peer_static);
    let driver = HandshakeDriver::initiator(static_secret, &prologue)?;
    let (tx, rx, _hash, _confirm) = complete_handshake(&mut conn, driver, true).await?;
    Ok(SecureConnection::new(conn, tx, rx))
}

pub async fn recv_secure_transfer<T: FrameTransport + Send>(
    conn: &mut T,
    static_secret: &[u8; 32],
    initiator_static: &[u8; 32],
    out_dir: &Path,
    db: Option<&Db>,
    on_item: impl FnMut(EngineEvent),
) -> Result<Manifest> {
    let prologue = session_prologue(&x25519_public(static_secret), initiator_static);
    let driver = HandshakeDriver::responder(static_secret, &prologue)?;
    let (tx, rx, _hash, _confirm) = complete_handshake(conn, driver, false).await?;
    let mut secure = SecureConnection::new(conn, tx, rx);
    receive_transfer(&mut secure, out_dir, |_| {}, db, on_item).await
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

    /// R-T11-2: a socket-free pair of connections over an in-memory channel,
    /// with MIRRORED keys (the same [u8;32] as send_key and recv_key) so either
    /// end can encrypt and the other decrypt symmetrically. This is what lets the
    /// session-registry tests run without binding a port.
    #[cfg(test)]
    pub fn test_pair() -> (SecureConnection<MemConn>, SecureConnection<MemConn>) {
        let (a, b) = MemConn::pair();
        // Both ends get the SAME key, so a->b seals with it and b->a opens it.
        let key = [7u8; 32];
        (
            SecureConnection::new(a, key, key),
            SecureConnection::new(b, key, key),
        )
    }
}

/// R-T11-2: the in-memory FrameTransport behind `test_pair`. A send lands in the
/// peer end's bounded queue and is read by whatever drives the peer end; a
/// `send` fails only once the peer end (and so the channel) is dropped.
// ponytail: the channel is bounded at 64 frames, so a real multi-chunk transfer
// (>64 chunks / ~64 MiB at 1 MiB per chunk) blocks with no reader. Fine for the
// single-manifest test; only raise the bound if a test ever streams that much.
#[cfg(test)]
pub struct MemConn {
    tx: tokio::sync::mpsc::Sender<Frame>,
    rx: tokio::sync::mpsc::Receiver<Frame>,
}

#[cfg(test)]
impl MemConn {
    /// Two connected ends, returned left to right.
    pub fn pair() -> (MemConn, MemConn) {
        let (a_tx, b_rx) = tokio::sync::mpsc::channel(64);
        let (b_tx, a_rx) = tokio::sync::mpsc::channel(64);
        (
            MemConn { tx: a_tx, rx: a_rx },
            MemConn { tx: b_tx, rx: b_rx },
        )
    }
}

#[cfg(test)]
impl FrameTransport for MemConn {
    async fn send(&mut self, stream_id: u32, kind: RecordType, body: Bytes) -> Result<()> {
        self.tx
            .send(Frame::new(stream_id, kind, body))
            .await
            .map_err(|e| crate::CoreError::Protocol(e.to_string()))
    }
    async fn recv(&mut self) -> Result<Option<Frame>> {
        Ok(self.rx.recv().await)
    }
}

impl<T: FrameTransport + Send> FrameTransport for SecureConnection<T> {
    async fn send(&mut self, stream_id: u32, kind: RecordType, body: Bytes) -> Result<()> {
        // R3: a pending epoch change must be signalled before the first frame of
        // the new epoch. The signal is sealed under the RETIRING epoch so the
        // peer can still read it; the caller's frame below uses the new epoch.
        if self.session.will_rekey(body.len() as u64) {
            let rekey = ControlMsg::Rekey {
                epoch: self.session.epoch() + 1,
            };
            let ct = self
                .session
                .seal_current(0, RecordType::Rekey, &rekey.to_cbor()?)?;
            self.inner
                .send(0, RecordType::Rekey, Bytes::from(ct))
                .await?;
        }
        let ct = self.session.encrypt(stream_id, kind, &body)?;
        self.inner.send(stream_id, kind, Bytes::from(ct)).await
    }

    async fn recv(&mut self) -> Result<Option<Frame>> {
        loop {
            match self.inner.recv().await? {
                Some(f) => {
                    let pt = self.session.decrypt(f.stream_id, f.kind, &f.body)?;
                    // R4: Rekey frames are control-plane only — apply the epoch
                    // advance and never surface them to the transfer layer.
                    if f.kind == RecordType::Rekey {
                        let ControlMsg::Rekey { epoch } = ControlMsg::from_cbor(&pt)?;
                        self.session.advance_recv_epoch(epoch)?;
                        continue;
                    }
                    return Ok(Some(Frame::new(f.stream_id, f.kind, Bytes::from(pt))));
                }
                None => return Ok(None),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::HandshakeDriver;
    use crate::crypto::REKEY_BYTES;
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

    /// R6: recv_secure_transfer is what the Engine accept loop calls for an
    /// inbound transfer, and production now passes Some(&db) there. This drives
    /// the same function over MemConn -- no socket, no handshake state shared
    /// with the TCP tests -- and proves the transfers row actually lands.
    #[tokio::test]
    async fn recv_secure_transfer_with_a_db_persists_the_transfers_row() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let path = src.path().join("r6.bin");
        std::fs::write(&path, vec![9u8; 70_000]).unwrap();

        let a = crate::crypto::identity::Identity::generate().unwrap();
        let b = crate::crypto::identity::Identity::generate().unwrap();
        let item = crate::manifest::Item::from_file(0, &path, 64 * 1024).unwrap();
        let manifest = crate::manifest::Manifest::new(
            crate::manifest::PayloadKind::Media,
            crate::manifest::DeviceRef {
                device_id: a.device_id(),
                name: "a".into(),
            },
            vec![item],
        );

        let db = crate::store::Db::open_in_memory().unwrap();
        db.migrate().unwrap();

        let b_pub = b.public().x25519;
        let (mut mine, mut theirs) = MemConn::pair();
        let a_secret = a.static_secret().to_bytes();
        let b_secret = b.static_secret().to_bytes();
        let a_pub = a.public().x25519;
        let a_device_id = a.device_id();
        let m = manifest.clone();
        let sender = tokio::spawn(async move {
            let mut secure = open_secure(&mut theirs, &a_secret, &b_pub, a_device_id)
                .await
                .unwrap();
            send_transfer(&mut secure, &m, &[Some(path.clone())], &[], |_| {})
                .await
                .unwrap();
        });

        let got = recv_secure_transfer(&mut mine, &b_secret, &a_pub, dst.path(), Some(&db), |_| {})
            .await
            .unwrap();
        sender.await.unwrap();

        assert_eq!(got.payload_id, manifest.payload_id);
        let row = db.get_transfer(&manifest.payload_id).unwrap().unwrap();
        assert_eq!(row.direction, "in");
        assert_eq!(row.state, "done");
        assert_eq!(row.bytes_done, 70_000);
    }

    /// Wraps a Chan and counts the RecordType::Rekey frames that leave it, so a
    /// test can prove the send path actually emitted the signal on the wire.
    struct CountingChan {
        inner: Chan,
        rekeys: usize,
    }

    impl FrameTransport for CountingChan {
        async fn send(
            &mut self,
            stream_id: u32,
            kind: RecordType,
            body: Bytes,
        ) -> crate::Result<()> {
            if kind == RecordType::Rekey {
                self.rekeys += 1;
            }
            self.inner.send(stream_id, kind, body).await
        }
        async fn recv(&mut self) -> crate::Result<Option<Frame>> {
            self.inner.recv().await
        }
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
        let (a_tx, a_rx, _a_hash, _) = a_side.unwrap();
        let (b_tx, b_rx, _b_hash, _) = b_side.unwrap();

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

    #[tokio::test]
    async fn send_emits_rekey_and_the_peer_follows() {
        let (a_io, b_io) = channel_pair();
        let sending = CountingChan {
            inner: a_io,
            rekeys: 0,
        };
        // Mirrored directional keys; only a -> b is exercised here.
        let (tx, rx) = ([1u8; 32], [2u8; 32]);
        let mut a = SecureConnection::new(sending, tx, rx);
        let mut b = SecureConnection::new(b_io, rx, tx);

        // Retire the sender's epoch on the very next frame.
        a.session.force_sent_bytes(REKEY_BYTES);

        a.send(9, RecordType::Chunk, Bytes::from_static(b"payload"))
            .await
            .unwrap();

        // The receiver follows the epoch change: recv absorbs the Rekey frame
        // and returns the data frame that was sealed under the new epoch.
        let f = b.recv().await.unwrap().unwrap();
        assert_eq!(f.stream_id, 9);
        assert_ne!(f.kind, RecordType::Rekey, "rekey must not be surfaced");
        assert_eq!(&f.body[..], b"payload");

        // Wire-level proof the signal was emitted: 0 without the will_rekey
        // block in send, and the panic above would fire first anyway.
        assert_eq!(
            a.inner.rekeys, 1,
            "send must emit one RecordType::Rekey frame before new-epoch data"
        );
    }
}
