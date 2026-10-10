use std::collections::HashMap;

use crate::crypto::replay::ReplayWindow;

use super::presence::PresenceState;

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
    session_id: [u8; 16],
    liveness: Liveness,
    last_seen_ms: u64,
    /// The time of the last liveness change. Used to absorb a brief blip.
    last_change_ms: Option<u64>,
}

impl PeerStatus {
    fn new(device_id: [u8; 16], now_ms: u64) -> Self {
        Self {
            device_id,
            session_id: [0u8; 16],
            liveness: Liveness::Offline,
            last_seen_ms: now_ms,
            last_change_ms: None,
        }
    }
}

pub struct PresenceTracker {
    cfg: PresenceConfig,
    peers: HashMap<[u8; 16], PeerStatus>,
    windows: HashMap<[u8; 16], ReplayWindow>,
    declared: HashMap<[u8; 16], Declared>,
}

/// What a peer declared about itself in its latest accepted beacon, with the
/// session and the sequence number that carried it.
#[derive(Debug, Clone, Copy)]
struct Declared {
    state: PresenceState,
    session_id: [u8; 16],
    seq: u64,
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
            declared: HashMap::new(),
        }
    }

    pub fn set_config(&mut self, cfg: PresenceConfig) {
        self.cfg = cfg;
    }

    /// Accepts a fresh beacon and reports a liveness change, if any.
    pub fn observe(&mut self, peer: [u8; 16], seq: u64, now_ms: u64) -> Option<StatusChange> {
        self.observe_session(peer, [0u8; 16], seq, now_ms)
    }

    /// Accepts a fresh beacon with its per-process session id.
    ///
    /// A new session id means the peer restarted. A restart is not a blip, so
    /// the replay window resets and the flap window does not absorb the event.
    /// The outer None means the replay window rejected the beacon.
    fn accept_beacon(
        &mut self,
        peer: [u8; 16],
        session_id: [u8; 16],
        seq: u64,
        now_ms: u64,
    ) -> Option<Option<StatusChange>> {
        let known = self
            .peers
            .get(&peer)
            .map(|s| s.session_id)
            .unwrap_or([0u8; 16]);
        let restarted = known != [0u8; 16] && known != session_id;
        if restarted {
            // A new session restarts the sequence, so accept seq from 1.
            self.windows.remove(&peer);
            // CORRECTION 1: clear the flap state, so a restart always emits
            // Online and is not dropped as a brief blip.
            if let Some(s) = self.peers.get_mut(&peer) {
                s.last_change_ms = None;
            }
        }

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
        s.session_id = session_id;
        s.last_seen_ms = now_ms;
        Some(match s.liveness {
            Liveness::Online => None,
            Liveness::Offline => {
                let briefly_offline = s
                    .last_change_ms
                    .is_some_and(|t| now_ms.saturating_sub(t) < self.cfg.flap_debounce_ms);
                s.liveness = Liveness::Online;
                s.last_change_ms = Some(now_ms);
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
        })
    }

    /// Accepts a fresh beacon with its per-process session id.
    ///
    /// A new session id means the peer restarted. A restart is not a blip, so
    /// the replay window resets and the flap window does not absorb the event.
    pub fn observe_session(
        &mut self,
        peer: [u8; 16],
        session_id: [u8; 16],
        seq: u64,
        now_ms: u64,
    ) -> Option<StatusChange> {
        self.accept_beacon(peer, session_id, seq, now_ms).flatten()
    }

    /// Same as observe_session, and also records what the peer declared.
    /// The value is stored only when the replay window accepted the beacon
    /// and the beacon is newer than the stored one in the same session. The
    /// window rejects a duplicate sequence number but accepts an older one
    /// that it never saw, so the window alone does not stop an old beacon
    /// from undoing a newer Away. True means the declared state changed, so a
    /// caller emits one event for a change and none for a repeated beacon.
    pub fn observe_session_declared(
        &mut self,
        peer: [u8; 16],
        session_id: [u8; 16],
        seq: u64,
        now_ms: u64,
        declared: PresenceState,
    ) -> (Option<StatusChange>, bool) {
        let Some(change) = self.accept_beacon(peer, session_id, seq, now_ms) else {
            return (None, false);
        };
        let previous = self.declared.get(&peer).copied();
        if previous.is_some_and(|d| d.session_id == session_id && seq <= d.seq) {
            return (change, false);
        }
        self.declared.insert(
            peer,
            Declared {
                state: declared,
                session_id,
                seq,
            },
        );
        (change, previous.map(|d| d.state) != Some(declared))
    }

    pub fn declared(&self, peer: &[u8; 16]) -> Option<PresenceState> {
        self.declared.get(peer).map(|d| d.state)
    }

    /// Heartbeat: declares offline for peers whose last beacon is older than the timeout.
    pub fn tick(&mut self, now_ms: u64) -> Vec<StatusChange> {
        let timeout = self.cfg.offline_timeout_ms();
        let mut changes = Vec::new();
        for s in self.peers.values_mut() {
            let stale = now_ms.saturating_sub(s.last_seen_ms) >= timeout;
            if s.liveness == Liveness::Online && stale {
                s.liveness = Liveness::Offline;
                s.last_change_ms = Some(now_ms);
                self.declared.remove(&s.device_id);
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
        self.declared.remove(peer);
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

#[cfg(test)]
mod declared_tests {
    use super::super::presence::PresenceState;
    use super::PresenceTracker;

    const P: [u8; 16] = [1u8; 16];
    const S: [u8; 16] = [9u8; 16];

    #[test]
    fn a_replayed_or_older_beacon_does_not_change_the_declared_state() {
        let mut t = PresenceTracker::default();
        let (_, changed) = t.observe_session_declared(P, S, 5, 1_000, PresenceState::Away);
        assert!(changed);
        let (_, changed) = t.observe_session_declared(P, S, 5, 2_000, PresenceState::Online);
        assert!(!changed);
        let (_, changed) = t.observe_session_declared(P, S, 4, 3_000, PresenceState::Online);
        assert!(!changed);
        assert_eq!(t.declared(&P), Some(PresenceState::Away));
        let (_, changed) = t.observe_session_declared(P, S, 6, 4_000, PresenceState::Online);
        assert!(changed);
        assert_eq!(t.declared(&P), Some(PresenceState::Online));
    }

    #[test]
    fn a_new_session_restarts_the_declared_sequence() {
        let mut t = PresenceTracker::default();
        let p = [1u8; 16];
        t.observe_session_declared(p, [9u8; 16], 50, 1_000, PresenceState::Away);
        let (_, changed) =
            t.observe_session_declared(p, [8u8; 16], 1, 2_000, PresenceState::Online);
        assert!(changed);
        assert_eq!(t.declared(&p), Some(PresenceState::Online));
    }

    #[test]
    fn declared_presence_reports_a_change_once_and_is_forgotten() {
        let mut t = PresenceTracker::default();
        let p = [1u8; 16];
        let s = [9u8; 16];
        assert_eq!(t.declared(&p), None);
        assert!(
            t.observe_session_declared(p, s, 1, 1_000, PresenceState::Online)
                .1
        );
        assert!(
            !t.observe_session_declared(p, s, 2, 2_000, PresenceState::Online)
                .1
        );
        assert!(
            t.observe_session_declared(p, s, 3, 3_000, PresenceState::Away)
                .1
        );
        assert_eq!(t.declared(&p), Some(PresenceState::Away));
        t.forget(&p);
        assert_eq!(t.declared(&p), None);
    }

    #[test]
    fn declared_presence_is_cleared_when_the_peer_goes_offline() {
        let mut t = PresenceTracker::default();
        let p = [1u8; 16];
        let s = [9u8; 16];
        t.observe_session_declared(p, s, 5, 1_000, PresenceState::Away);
        assert_eq!(
            t.tick(1_000_000).len(),
            1,
            "the peer is offline after the timeout"
        );
        assert_eq!(t.declared(&p), None);
        let (_, changed) = t.observe_session_declared(p, s, 6, 2_000_000, PresenceState::Away);
        assert!(changed);
    }
}
