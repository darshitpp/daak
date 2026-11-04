//! A `FrameTransport` wrapper for the pipeline tests. It can delay a `send`
//! or a `recv`, fail at a given call, and block on a gate. The sender tests
//! and the receiver tests use it.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use tokio::sync::Notify;

use crate::error::{CoreError, Result};
use crate::framing::{Frame, RecordType};
use crate::net::FrameTransport;

/// Wraps a `FrameTransport`. Each setting is off until a test sets it.
pub(crate) struct TestTransport<T> {
    inner: T,
    send_delay: Duration,
    recv_delay: Duration,
    /// The 1-based number of the `send` call that fails.
    fail_send_at: Option<usize>,
    /// The count of `recv` calls that succeed. Each later `recv` fails.
    fail_recv_after: Option<usize>,
    /// While this is `Some`, each `send` and each `recv` waits for one
    /// permit. After the first permit, the gate is open for good.
    gate: Option<Arc<Notify>>,
    sends: usize,
    recvs: usize,
    completed_sends: Arc<AtomicUsize>,
}

impl<T> TestTransport<T> {
    pub(crate) fn new(inner: T) -> Self {
        Self {
            inner,
            send_delay: Duration::ZERO,
            recv_delay: Duration::ZERO,
            fail_send_at: None,
            fail_recv_after: None,
            gate: None,
            sends: 0,
            recvs: 0,
            completed_sends: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Each `send` sleeps for `delay` before it forwards the frame.
    pub(crate) fn with_send_delay(mut self, delay: Duration) -> Self {
        self.send_delay = delay;
        self
    }

    /// Each `recv` sleeps for `delay` before it reads a frame.
    pub(crate) fn with_recv_delay(mut self, delay: Duration) -> Self {
        self.recv_delay = delay;
        self
    }

    /// The `send` call with the 1-based number `n` fails and sends nothing.
    pub(crate) fn fail_send_at(mut self, n: usize) -> Self {
        self.fail_send_at = Some(n);
        self
    }

    /// The first `n` `recv` calls succeed. Each later `recv` fails.
    pub(crate) fn fail_recv_after(mut self, n: usize) -> Self {
        self.fail_recv_after = Some(n);
        self
    }

    /// The next `send` or `recv` waits until `gate` gets a permit
    /// (`notify_one`). Then the gate stays open.
    pub(crate) fn block_until(mut self, gate: Arc<Notify>) -> Self {
        self.gate = Some(gate);
        self
    }

    /// A counter of the `send` calls that completed with `Ok`.
    pub(crate) fn completed_sends(&self) -> Arc<AtomicUsize> {
        self.completed_sends.clone()
    }

    async fn pass_gate(&mut self) {
        if let Some(gate) = self.gate.take() {
            gate.notified().await;
        }
    }
}

impl<T: FrameTransport + Send> FrameTransport for TestTransport<T> {
    async fn send(&mut self, stream_id: u32, kind: RecordType, body: Bytes) -> Result<()> {
        self.sends += 1;
        self.pass_gate().await;
        if !self.send_delay.is_zero() {
            tokio::time::sleep(self.send_delay).await;
        }
        if self.fail_send_at == Some(self.sends) {
            return Err(CoreError::Protocol("test transport: send failed".into()));
        }
        self.inner.send(stream_id, kind, body).await?;
        self.completed_sends.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn recv(&mut self) -> Result<Option<Frame>> {
        self.recvs += 1;
        self.pass_gate().await;
        if !self.recv_delay.is_zero() {
            tokio::time::sleep(self.recv_delay).await;
        }
        if self.fail_recv_after.is_some_and(|n| self.recvs > n) {
            return Err(CoreError::Protocol("test transport: recv failed".into()));
        }
        self.inner.recv().await
    }
}

mod tests {
    use super::*;
    use crate::net::secure::{MemConn, SecureConnection};

    /// The receive settings work. The receiver tests (Task 3) depend on them.
    #[tokio::test]
    async fn recv_delay_and_recv_failure_apply() {
        let (mut mine, theirs) = SecureConnection::<MemConn>::test_pair();
        let mut theirs = TestTransport::new(theirs)
            .with_recv_delay(Duration::from_millis(20))
            .fail_recv_after(1);
        mine.send(0, RecordType::Ack, Bytes::from_static(b"a"))
            .await
            .unwrap();
        mine.send(0, RecordType::Ack, Bytes::from_static(b"b"))
            .await
            .unwrap();
        let start = std::time::Instant::now();
        let first = theirs.recv().await.unwrap().unwrap();
        assert!(start.elapsed() >= Duration::from_millis(20));
        assert_eq!(&first.body[..], b"a");
        assert!(theirs.recv().await.is_err());
    }
}
