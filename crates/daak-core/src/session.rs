//! Per-pair multiplexed session registry (spec §2.5.2): one authenticated
//! connection per peer, reused across transfers, evicted when idle or broken.
//!
//! The registry owns dialling. A caller hands it a peer device id; the connect
//! closure supplied at construction resolves that peer's address and performs
//! the Noise XX handshake. Everything past the handshake rides `Session::conn`.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use crate::error::Result;
use crate::net::secure::SecureConnection;
use futures::future::BoxFuture;

/// Logical stream ids over one authenticated connection (spec §2.5.2).
/// Re-exported, not redefined: net::connection::CONTROL_STREAM is the value
/// every other layer already uses.
pub use crate::net::CONTROL_STREAM;
pub const ITEM_STREAM_BASE: u32 = 100;

// ponytail: the receiver ignores `stream_id` entirely, so nothing enforces
// separation between the control stream and item streams at the far end --
// multiplexed receive is unverified. Add a receiver-side check on stream_id when
// the receive path ever needs to interleave streams.
pub fn item_stream(item_index: u32) -> u32 {
    ITEM_STREAM_BASE + item_index
}

/// The concrete transport the Engine dials. The third generic parameter with
/// this default keeps every production call site written as
/// SessionRegistry<F, Fut>; the tests substitute the in-memory MemConn, which is
/// the whole point of keeping the registry socket-free.
pub type TcpConn = crate::net::Connection<tokio::net::TcpStream>;

pub struct Session<T = TcpConn> {
    pub conn: SecureConnection<T>,
    last_used: Instant,
    broken: bool,
}

impl<T> Session<T> {
    pub fn new(conn: SecureConnection<T>) -> Self {
        Self {
            conn,
            last_used: Instant::now(),
            broken: false,
        }
    }
    pub fn touch(&mut self) {
        self.last_used = Instant::now();
    }
    pub fn mark_broken(&mut self) {
        self.broken = true;
    }
    pub fn is_broken(&self) -> bool {
        self.broken
    }
}

pub type SessionHandle<T = TcpConn> = Arc<Mutex<Session<T>>>;

/// The Engine's connect closure, boxed so a registry type alias can be written.
/// (R-T11-11's fallback shape; the unboxed `F, Fut` generics below are what the
/// tests exercise.) A bare Box, not an Arc: std has no `impl Fn for Arc<dyn Fn>`.
pub type BoxConnect<T = TcpConn> =
    Box<dyn Fn([u8; 16]) -> BoxFuture<'static, Result<SecureConnection<T>>> + Send + Sync>;

pub type BoxFutureConn<T = TcpConn> = BoxFuture<'static, Result<SecureConnection<T>>>;

/// What the Engine stores: shared, so a per-row outbox drain task that cannot
/// hold a borrow of the Engine drives sends through the SAME sessions.
pub type SharedSessions<T = TcpConn> =
    Arc<Mutex<SessionRegistry<BoxConnect<T>, BoxFutureConn<T>, T>>>;

pub struct SessionRegistry<F, Fut, T = TcpConn>
where
    F: Fn([u8; 16]) -> Fut + Send + Sync,
    Fut: Future<Output = Result<SecureConnection<T>>> + Send,
{
    sessions: HashMap<[u8; 16], SessionHandle<T>>,
    idle_timeout: Duration,
    connect: F,
}

// ponytail: R-T11-9 ruled OUT a keepalive/probe task, so a dead peer is only
// discovered on the next send attempt -- an idle session can sit broken (or the
// peer can vanish) until then. Add a periodic probe only if the UI needs to
// show connection state proactively.

impl<F, Fut, T> SessionRegistry<F, Fut, T>
where
    F: Fn([u8; 16]) -> Fut + Send + Sync,
    Fut: Future<Output = Result<SecureConnection<T>>> + Send,
{
    pub fn new(idle_timeout: Duration, connect: F) -> Self {
        Self {
            sessions: HashMap::new(),
            idle_timeout,
            connect,
        }
    }

    pub async fn get_or_connect(&mut self, peer: [u8; 16]) -> Result<SessionHandle<T>> {
        self.evict_idle();
        if let Some(existing) = self.sessions.get(&peer).cloned() {
            // try_lock, NOT lock().await: the session lock is held for a whole
            // transfer, so awaiting it here would make the registry a global
            // serialisation point -- one in-flight transfer would block every
            // peer's get_or_connect/remove/evict. The queueing belongs on the
            // session, where `send_on_session` already does it.
            // ponytail: a busy session is trusted without re-checking `broken`;
            // safe only because `mark_broken` needs the same lock, so a locked
            // session cannot be broken. Revisit if broken ever moves elsewhere.
            match existing.try_lock() {
                Ok(mut s) => {
                    if !s.is_broken() {
                        s.touch();
                        return Ok(existing.clone());
                    }
                    drop(s);
                    self.sessions.remove(&peer);
                }
                Err(_) => return Ok(existing.clone()),
            }
        }
        let conn = (self.connect)(peer).await?;
        let handle = Arc::new(Mutex::new(Session::new(conn)));
        self.sessions.insert(peer, handle.clone());
        Ok(handle)
    }

    pub fn remove(&mut self, peer: &[u8; 16]) {
        self.sessions.remove(peer);
    }

    fn evict_idle(&mut self) {
        let timeout = self.idle_timeout;
        self.sessions.retain(|_, s| match s.try_lock() {
            Ok(s) => s.last_used.elapsed() < timeout && !s.broken,
            // A held lock means a transfer is in flight: in use, do not evict.
            Err(_) => true,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::secure::MemConn;
    use futures::future::BoxFuture;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    fn counter() -> Arc<AtomicUsize> {
        Arc::new(AtomicUsize::new(0))
    }

    /// R-T11-1/R-T11-2: the registry is generic over the transport, so these
    /// tests inject the in-memory channel pair instead of a TCP dial.
    type Reg = SessionRegistry<
        Box<
            dyn Fn([u8; 16]) -> BoxFuture<'static, Result<SecureConnection<MemConn>>> + Send + Sync,
        >,
        BoxFuture<'static, Result<SecureConnection<MemConn>>>,
        MemConn,
    >;

    fn registry(idle: Duration, connects: Arc<AtomicUsize>) -> Reg {
        let connect = move |_peer: [u8; 16]| {
            let c = connects.clone();
            Box::pin(async move {
                c.fetch_add(1, Ordering::SeqCst);
                Ok(SecureConnection::<MemConn>::test_pair().0)
            }) as BoxFuture<'static, Result<SecureConnection<MemConn>>>
        };
        SessionRegistry::new(
            idle,
            Box::new(connect)
                as Box<
                    dyn Fn([u8; 16]) -> BoxFuture<'static, Result<SecureConnection<MemConn>>>
                        + Send
                        + Sync,
                >,
        )
    }

    #[tokio::test]
    async fn two_sequential_transfers_reuse_one_session() {
        let connects = counter();
        let mut reg = registry(Duration::from_secs(30), connects.clone());

        let first = reg.get_or_connect([1u8; 16]).await.unwrap();
        let second = reg.get_or_connect([1u8; 16]).await.unwrap();
        assert!(
            Arc::ptr_eq(&first, &second),
            "same peer must reuse the session"
        );
        assert_eq!(
            connects.load(Ordering::SeqCst),
            1,
            "exactly one TCP accept for two transfers"
        );
    }

    #[tokio::test]
    async fn dropped_connection_is_transparently_reestablished() {
        let connects = counter();
        let mut reg = registry(Duration::from_secs(30), connects.clone());

        let first = reg.get_or_connect([2u8; 16]).await.unwrap();
        first.lock().await.mark_broken();
        let second = reg.get_or_connect([2u8; 16]).await.unwrap();
        assert!(
            !Arc::ptr_eq(&first, &second),
            "a broken session is replaced"
        );
        assert_eq!(connects.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn an_idle_session_is_evicted_and_the_next_send_redials() {
        let connects = counter();
        let mut reg = registry(Duration::from_millis(20), connects.clone());

        let first = reg.get_or_connect([3u8; 16]).await.unwrap();
        // Still fresh: no second dial.
        let same = reg.get_or_connect([3u8; 16]).await.unwrap();
        assert!(Arc::ptr_eq(&first, &same));
        assert_eq!(connects.load(Ordering::SeqCst), 1);

        tokio::time::sleep(Duration::from_millis(60)).await;
        let fresh = reg.get_or_connect([3u8; 16]).await.unwrap();
        assert!(
            !Arc::ptr_eq(&first, &fresh),
            "an idle session past the timeout must be dropped"
        );
        assert_eq!(connects.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn remove_forces_a_reconnect() {
        let connects = counter();
        let mut reg = registry(Duration::from_secs(30), connects.clone());

        let first = reg.get_or_connect([4u8; 16]).await.unwrap();
        reg.remove(&[4u8; 16]);
        let second = reg.get_or_connect([4u8; 16]).await.unwrap();
        assert!(!Arc::ptr_eq(&first, &second));
        assert_eq!(connects.load(Ordering::SeqCst), 2);
    }

    /// F-1: `get_or_connect` holds the registry lock, and the session lock is
    /// held for a WHOLE transfer by `send_on_session`. Awaiting it under the
    /// registry lock makes every peer serialise behind one in-flight transfer.
    #[tokio::test]
    async fn get_or_connect_does_not_block_behind_an_in_flight_transfer() {
        let connects = counter();
        let mut reg = registry(Duration::from_secs(30), connects.clone());
        let handle = reg.get_or_connect([5u8; 16]).await.unwrap();

        // A transfer holds `handle`'s session lock for its whole duration.
        let guard = handle.clone().lock_owned().await;

        // A registry op for that peer must still return promptly, and no second
        // dial may happen: the cached session is handed back as-is.
        let again = tokio::time::timeout(Duration::from_millis(200), reg.get_or_connect([5u8; 16]))
            .await
            .expect("get_or_connect blocked on a session lock")
            .unwrap();
        assert!(Arc::ptr_eq(&handle, &again));
        assert_eq!(connects.load(Ordering::SeqCst), 1);
        drop(guard);
    }

    /// F-2/F-3: the in-memory transport carries a REAL send_transfer, and a peer
    /// that acks a FOREIGN transfer id is a protocol violation, not a success.
    #[tokio::test]
    async fn an_ack_for_another_transfer_is_rejected() {
        // The connect closure keeps the peer end so a stub peer can answer.
        let peer: Arc<tokio::sync::Mutex<Option<SecureConnection<MemConn>>>> =
            Arc::new(tokio::sync::Mutex::new(None));
        let slot = peer.clone();
        let connect = move |_p: [u8; 16]| {
            let slot = slot.clone();
            Box::pin(async move {
                let (mine, theirs) = SecureConnection::<MemConn>::test_pair();
                *slot.lock().await = Some(theirs);
                Ok(mine)
            }) as BoxFuture<'static, Result<SecureConnection<MemConn>>>
        };
        let mut reg = SessionRegistry::new(
            Duration::from_secs(30),
            Box::new(connect)
                as Box<
                    dyn Fn([u8; 16]) -> BoxFuture<'static, Result<SecureConnection<MemConn>>>
                        + Send
                        + Sync,
                >,
        );

        let manifest = crate::manifest::Manifest::text("hello");
        let handle = reg.get_or_connect([6u8; 16]).await.unwrap();

        let stub = tokio::spawn(async move {
            let mut theirs = peer.lock().await.take().unwrap();
            let mf = theirs.recv().await.unwrap().unwrap();
            assert_eq!(mf.kind, crate::framing::RecordType::Manifest);
            // A DIFFERENT transfer: the payload_id is chosen by Manifest::text.
            let ack = crate::control::AckMsg {
                transfer_id: [0xAB; 16],
                item_index: 0,
                complete: true,
                hash_ok: true,
            };
            use crate::net::FrameTransport;
            theirs
                .send(
                    CONTROL_STREAM,
                    crate::framing::RecordType::Ack,
                    bytes::Bytes::from(ack.to_cbor().unwrap()),
                )
                .await
                .unwrap();
        });

        let mut s = handle.lock().await;
        let err = crate::transfer::send_transfer(&mut s.conn, &manifest, &[], &[], |_| {})
            .await
            .unwrap_err();
        assert!(
            matches!(&err, crate::CoreError::Protocol(m) if m == "ack for a different transfer"),
            "a foreign ack must be a protocol error, got {err:?}"
        );
        drop(s);
        stub.await.unwrap();
    }
}
