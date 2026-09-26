//! Backpressure and rate-limit primitives.
//!
//! NOT YET WIRED into the send or receive path. `send_transfer` already awaits
//! `conn.send()` per chunk, so a slow peer blocks the reader directly; a bounded
//! channel plus a parallel writer task would add a task, a channel and an
//! error-propagation path with zero behavioural change. These types exist so the
//! limits are specified and tested in one place; wire them in when a real
//! buffering problem shows up, and update this comment then.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use tokio::sync::mpsc;

/// Upper bound on concurrent logical item streams per pair.
pub const MAX_CONCURRENT_STREAMS: usize = 8;

#[derive(Debug, Default)]
pub struct ChunkFrame {
    pub item_index: u32,
    pub chunk_index: u64,
    pub bytes: Vec<u8>,
}

/// The single backpressuring hop between a file reader and a socket writer.
/// `mpsc`'s bounded capacity makes a slow receiver block the reader naturally.
pub fn bounded_chunk_channel(
    capacity: usize,
) -> (mpsc::Sender<ChunkFrame>, mpsc::Receiver<ChunkFrame>) {
    mpsc::channel(capacity)
}

/// Classic token bucket; refilled lazily from the wall clock.
pub struct TokenBucket {
    rate_per_sec: f64,
    burst: f64,
    tokens: f64,
    last: Instant,
}

impl TokenBucket {
    pub fn new(rate_per_sec: u32, burst: u32) -> Self {
        let burst = burst.max(1) as f64;
        Self {
            rate_per_sec: rate_per_sec.max(1) as f64,
            burst,
            tokens: burst,
            last: Instant::now(),
        }
    }

    fn refill(&mut self) {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.rate_per_sec).min(self.burst);
        self.last = now;
    }

    pub fn try_acquire(&mut self) -> bool {
        self.refill();
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    pub async fn acquire(&mut self) {
        while !self.try_acquire() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

pub struct PeerRateLimiter {
    by_peer: HashMap<[u8; 16], (TokenBucket, usize)>,
    rate_per_sec: u32,
    burst: u32,
}

impl PeerRateLimiter {
    pub fn new(rate_per_sec: u32, burst: u32) -> Self {
        Self {
            by_peer: HashMap::new(),
            rate_per_sec,
            burst,
        }
    }

    fn entry(&mut self, peer: [u8; 16]) -> &mut (TokenBucket, usize) {
        let (rate, burst) = (self.rate_per_sec, self.burst);
        self.by_peer
            .entry(peer)
            .or_insert_with(|| (TokenBucket::new(rate, burst), 0))
    }

    /// Returns `true` if a new item stream may start; counts against the cap.
    /// R-T12-8: whoever wins MUST pair this with `release_stream` on every return
    /// path, including the error paths, or the peer leaks a slot per failure.
    pub fn try_acquire_stream(&mut self, peer: [u8; 16]) -> bool {
        let e = self.entry(peer);
        if e.1 >= MAX_CONCURRENT_STREAMS || !e.0.try_acquire() {
            return false;
        }
        e.1 += 1;
        true
    }

    pub fn release_stream(&mut self, peer: [u8; 16]) {
        if let Some(e) = self.by_peer.get_mut(&peer) {
            e.1 = e.1.saturating_sub(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_channel_rejects_past_capacity() {
        let (tx, _rx) = bounded_chunk_channel(2);
        assert!(tx.try_send(ChunkFrame::default()).is_ok());
        assert!(tx.try_send(ChunkFrame::default()).is_ok());
        assert!(
            tx.try_send(ChunkFrame::default()).is_err(),
            "capacity must be enforced"
        );
    }

    #[test]
    fn token_bucket_rejects_beyond_burst() {
        let mut b = TokenBucket::new(1, 2);
        assert!(b.try_acquire());
        assert!(b.try_acquire());
        assert!(!b.try_acquire(), "third token exceeds the burst of 2");
    }

    #[test]
    fn concurrent_stream_cap_is_enforced_per_peer() {
        let mut r = PeerRateLimiter::new(1000, 100);
        for i in 0..MAX_CONCURRENT_STREAMS {
            assert!(r.try_acquire_stream([1u8; 16]), "stream {i} within cap");
        }
        assert!(
            !r.try_acquire_stream([1u8; 16]),
            "stream beyond cap is rejected"
        );
        assert!(
            r.try_acquire_stream([2u8; 16]),
            "the cap is per peer, not global"
        );
    }

    #[test]
    fn release_stream_frees_a_slot() {
        let mut r = PeerRateLimiter::new(1000, 100);
        for _ in 0..MAX_CONCURRENT_STREAMS {
            assert!(r.try_acquire_stream([1u8; 16]));
        }
        assert!(!r.try_acquire_stream([1u8; 16]));
        r.release_stream([1u8; 16]);
        assert!(r.try_acquire_stream([1u8; 16]));
    }

    /// The `acquire` loop must actually return once the bucket refills; a wait
    /// that never yields a token is the failure this pins.
    #[tokio::test]
    async fn acquire_returns_after_the_bucket_refills() {
        let mut b = TokenBucket::new(50, 1);
        assert!(b.try_acquire(), "the burst token is spent first");
        assert!(!b.try_acquire(), "nothing left until the bucket refills");
        tokio::time::timeout(Duration::from_secs(2), b.acquire())
            .await
            .expect("acquire must return once a token is refilled");
    }
}
