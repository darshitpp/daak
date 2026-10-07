use daak_core::discovery::status::{Liveness, PresenceConfig, PresenceTracker};

const PEER: [u8; 16] = [7u8; 16];
const SESSION_A: [u8; 16] = [1u8; 16];
const SESSION_B: [u8; 16] = [2u8; 16];

fn cfg() -> PresenceConfig {
    PresenceConfig {
        beacon_interval_ms: 2_000,
        offline_misses: 3,
        flap_debounce_ms: 1_000,
    }
}

#[test]
fn restarted_peer_with_new_session_is_online_not_stale() {
    let mut t = PresenceTracker::new(cfg());
    assert_eq!(
        t.observe_session(PEER, SESSION_A, 9, 0).map(|c| c.state),
        Some(Liveness::Online)
    );
    assert_eq!(t.tick(6_001).len(), 1, "peer is offline after the timeout");
    assert!(!t.is_online(&PEER));

    // Restart: same device, brand-new session, sequence resets to 1.
    let change = t.observe_session(PEER, SESSION_B, 1, 6_100);
    assert_eq!(change.map(|c| c.state), Some(Liveness::Online));
    assert!(
        t.is_online(&PEER),
        "a restart must not be dropped as a stale sequence"
    );
}

#[test]
fn beacon_older_than_the_configured_timeout_marks_offline() {
    let mut t = PresenceTracker::new(cfg());
    t.observe_session(PEER, SESSION_A, 1, 0);
    assert!(t.tick(5_999).is_empty(), "just under the timeout");
    let changes = t.tick(6_000);
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].state, Liveness::Offline);
}

#[test]
fn duplicate_and_stale_monotonic_seq_are_ignored() {
    let mut t = PresenceTracker::new(cfg());
    assert!(t.observe_session(PEER, SESSION_A, 10, 0).is_some());
    assert!(
        t.observe_session(PEER, SESSION_A, 10, 100).is_none(),
        "duplicate seq ignored"
    );
    assert!(
        t.observe_session(PEER, SESSION_A, 9, 200).is_none(),
        "stale seq ignored"
    );
    assert!(
        t.observe_session(PEER, SESSION_A, 11, 300).is_none(),
        "still online, no repeat event"
    );
    assert!(t.is_online(&PEER));
}

#[test]
fn flap_within_the_debounce_window_does_not_repeat_state_changes() {
    let mut t = PresenceTracker::new(cfg());
    t.observe_session(PEER, SESSION_A, 1, 0);
    assert_eq!(t.tick(6_000).len(), 1, "exactly one offline emission");
    assert!(
        t.observe_session(PEER, SESSION_A, 2, 6_200).is_none(),
        "blip is absorbed, no online event"
    );
    assert!(t.is_online(&PEER));
    assert!(
        t.tick(7_000).is_empty(),
        "no repeated offline after the blip"
    );
}

#[test]
fn timeout_uses_the_runtime_config() {
    let mut t = PresenceTracker::new(cfg());
    t.set_config(PresenceConfig {
        beacon_interval_ms: 500,
        offline_misses: 4,
        flap_debounce_ms: 100,
    });
    t.observe_session(PEER, SESSION_A, 1, 0);
    assert!(t.tick(1_999).is_empty());
    assert_eq!(t.tick(2_000).len(), 1);
}
