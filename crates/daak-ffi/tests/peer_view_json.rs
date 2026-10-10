use daak_core::discovery::PresenceState;
use daak_core::engine::{EngineEvent, PeerView};
use daak_ffi::{ffi_event_json, peer_view_json, to_ffi_event};

fn view(paired: bool, presence: Option<PresenceState>) -> PeerView {
    PeerView {
        device_id: [0xab; 16],
        name: String::new(),
        addr: None,
        paired,
        presence,
    }
}

#[test]
fn an_unpaired_peer_has_no_presence_keys() {
    let v = peer_view_json(&view(false, None));
    assert_eq!(v["deviceId"], "ab".repeat(16));
    assert_eq!(v["name"], "");
    assert_eq!(v["addr"], "");
    assert_eq!(v["paired"], false);
    assert!(v.get("presence").is_none() && v.get("online").is_none());
}

#[test]
fn a_paired_peer_carries_presence_and_a_matching_online_flag() {
    for (p, name, online) in [
        (PresenceState::Online, "online", true),
        (PresenceState::Away, "away", true),
        (PresenceState::Offline, "offline", false),
    ] {
        let v = peer_view_json(&view(true, Some(p)));
        assert_eq!(v["presence"], name);
        assert_eq!(v["online"], online);
    }
}

#[test]
fn a_peer_presence_event_becomes_device_presence_json() {
    let ev = to_ffi_event(EngineEvent::PeerPresence {
        device_id: [0xab; 16],
        state: PresenceState::Away,
    });
    let v: serde_json::Value = serde_json::from_str(&ffi_event_json(&ev).unwrap()).unwrap();
    assert_eq!(v["type"], "device.presence");
    assert_eq!(v["deviceId"], "ab".repeat(16));
    assert_eq!(v["presence"], "away");
}
