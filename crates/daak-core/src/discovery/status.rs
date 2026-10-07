use std::collections::HashMap;

use crate::crypto::replay::ReplayWindow;

pub const BEACON_INTERVAL_MS: u64 = 2_000;
pub const OFFLINE_MISSES: u32 = 3;
pub const FLAP_DEBOUNCE_MS: u64 = 1_000;
pub const PRESENCE_REPLAY_WINDOW: u32 = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PresenceConfig {
    pub beacon_interval_ms: u64,
    pub offline_misses: u32,
    pub flap_debounce_ms: u64,
}

impl Default for PresenceConfig {
    fn default() -> Self {
        Self {
            beacon_interval_ms: BEACON_INTERVAL_MS,
            offline_misses: OFFLINE_MISSES,
            flap_debounce_ms: FLAP_DEBOUNCE_MS,
        }
    }
}

impl PresenceConfig {
    pub fn offline_timeout_ms(&self) -> u64 {
        self.beacon_interval_ms
            .saturating_mul(self.offline_misses as u64)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Liveness {
    Online,
    Offline,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusChange {
    pub device_id: [u8; 16],
    pub state: Liveness,
    pub at_ms: u64,
}

#[derive(Debug)]
struct PeerStatus {
    device_id: [u8; 16],
    liveness: Liveness,
    last_seen_ms: u64,
    offline_at_ms: Option<u64>,
}

impl PeerStatus {
    fn new(device_id: [u8; 16], now_ms: u64) -> Self {
        Self {
            device_id,
            liveness: Liveness::Offline,
            last_seen_ms: now_ms,
            offline_at_ms: None,
        }
    }
}

pub struct PresenceTracker {
    cfg: PresenceConfig,
    peers: HashMap<[u8; 16], PeerStatus>,
    windows: HashMap<[u8; 16], ReplayWindow>,
}

impl Default for PresenceTracker {
    fn default() -> Self {
        Self::new(PresenceConfig::default())
    }
}

impl PresenceTracker {
    pub fn new(cfg: PresenceConfig) -> Self {
        Self {
            cfg,
            peers: HashMap::new(),
            windows: HashMap::new(),
        }
    }

    /// Accepts a fresh beacon and reports a liveness change, if any.
    pub fn observe(&mut self, peer: [u8; 16], seq: u64, now_ms: u64) -> Option<StatusChange> {
        let window = self
            .windows
            .entry(peer)
            .or_insert_with(|| ReplayWindow::new(PRESENCE_REPLAY_WINDOW));
        if !window.accept(seq) {
            return None; // stale, duplicate, or replayed beacon
        }

        let s = self
            .peers
            .entry(peer)
            .or_insert_with(|| PeerStatus::new(peer, now_ms));
        s.last_seen_ms = now_ms;
        match s.liveness {
            Liveness::Online => None,
            Liveness::Offline => {
                let briefly_offline = s
                    .offline_at_ms
                    .is_some_and(|t| now_ms.saturating_sub(t) < self.cfg.flap_debounce_ms);
                s.liveness = Liveness::Online;
                s.offline_at_ms = None;
                if briefly_offline {
                    None // absorb the blip; the UI never saw a stable offline
                } else {
                    Some(StatusChange {
                        device_id: peer,
                        state: Liveness::Online,
                        at_ms: now_ms,
                    })
                }
            }
        }
    }

    /// Heartbeat: declares offline for peers whose last beacon is older than the timeout.
    pub fn tick(&mut self, now_ms: u64) -> Vec<StatusChange> {
        let timeout = self.cfg.offline_timeout_ms();
        let mut changes = Vec::new();
        for s in self.peers.values_mut() {
            let stale = now_ms.saturating_sub(s.last_seen_ms) >= timeout;
            if s.liveness == Liveness::Online && stale {
                s.liveness = Liveness::Offline;
                s.offline_at_ms = Some(now_ms);
                changes.push(StatusChange {
                    device_id: s.device_id,
                    state: Liveness::Offline,
                    at_ms: now_ms,
                });
            }
        }
        changes
    }

    pub fn is_online(&self, peer: &[u8; 16]) -> bool {
        self.peers
            .get(peer)
            .map(|s| s.liveness == Liveness::Online)
            .unwrap_or(false)
    }

    pub fn forget(&mut self, peer: &[u8; 16]) {
        self.peers.remove(peer);
        self.windows.remove(peer);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PEER: [u8; 16] = [1u8; 16];

    #[test]
    fn peer_goes_offline_after_misses_then_online_on_beacon() {
        let mut t = PresenceTracker::new(PresenceConfig::default());
        assert_eq!(
            t.observe(PEER, 1, 0).map(|c| c.state),
            Some(Liveness::Online)
        );
        assert!(t.tick(5_000).is_empty(), "5s < 6s timeout");
        let changes = t.tick(6_000);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].state, Liveness::Offline);
        assert!(!t.is_online(&PEER));

        assert_eq!(
            t.observe(PEER, 2, 7_500).map(|c| c.state),
            Some(Liveness::Online)
        );
        assert!(t.is_online(&PEER));
    }

    #[test]
    fn duplicate_and_stale_beacons_are_ignored() {
        let mut t = PresenceTracker::new(PresenceConfig::default());
        assert!(t.observe(PEER, 10, 0).is_some());
        assert!(t.observe(PEER, 10, 100).is_none(), "duplicate seq ignored");
        assert!(t.observe(PEER, 9, 200).is_none(), "stale seq ignored");
        assert!(t.is_online(&PEER));
    }

    #[test]
    fn brief_offline_blip_does_not_flap_the_ui() {
        let mut t = PresenceTracker::new(PresenceConfig::default());
        t.observe(PEER, 1, 0);
        assert_eq!(t.tick(6_000).len(), 1);
        // Returns 200ms after the offline declaration: absorbed silently.
        assert!(
            t.observe(PEER, 2, 6_200).is_none(),
            "blip must not emit an online event"
        );
        assert!(t.is_online(&PEER));
    }

    #[test]
    fn recovery_after_debounce_emits_online() {
        let mut t = PresenceTracker::new(PresenceConfig::default());
        t.observe(PEER, 1, 0);
        t.tick(6_000);
        assert_eq!(
            t.observe(PEER, 2, 7_500).map(|c| c.state),
            Some(Liveness::Online)
        );
    }

    #[test]
    fn timeout_scales_with_config() {
        let cfg = PresenceConfig {
            beacon_interval_ms: 500,
            offline_misses: 4,
            flap_debounce_ms: 100,
        };
        assert_eq!(cfg.offline_timeout_ms(), 2_000);
    }
}
