// The compatibility signal, end to end on the MOBILE bridge.
//
// Before this, a peer whose mDNS announce named a protocol version
// ensure_compatible refuses was dropped from the device map with nothing but a
// tracing::warn! (crates/daak-core/src/engine.rs discovery task). The UI had no
// way to learn such a peer existed, so the Open Design "update required" screen
// could only be built by inventing version numbers. These pin the whole path --
// EngineEvent -> FfiEvent -> the JSON packages/core/src/engine/types.ts reads --
// and assert BOTH numbers are carried, because a screen that shows only one
// cannot tell "they are newer" from "we are newer".
use daak_core::engine::EngineEvent;
use daak_ffi::{ffi_event_json, to_ffi_event, FfiEvent};

#[test]
fn the_json_carries_both_real_version_numbers() {
    let ev = to_ffi_event(EngineEvent::IncompatiblePeer {
        peer_device_id: [0x22u8; 16],
        peer_name: "Kitchen Tablet".into(),
        peer_version: 100,
        our_version: 1,
    });
    let json: serde_json::Value = serde_json::from_str(&ffi_event_json(&ev).unwrap()).unwrap();

    let mut keys: Vec<&str> = json
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "ourVersion",
            "peerDeviceId",
            "peerName",
            "peerVersion",
            "type"
        ]
    );
    assert_eq!(json["type"], "peer.incompatible");
    // 32 hex chars, the same id shape every other field on both bridges uses.
    assert_eq!(json["peerDeviceId"], "22".repeat(16));
    assert_eq!(json["peerName"], "Kitchen Tablet");
    // THE point of the event: no version is defaulted, rounded or invented.
    assert_eq!(json["peerVersion"], 100);
    assert_eq!(json["ourVersion"], 1);
}

#[test]
fn the_engine_event_maps_onto_the_ffi_union_with_a_hex_id() {
    let FfiEvent::IncompatiblePeer { data } = to_ffi_event(EngineEvent::IncompatiblePeer {
        peer_device_id: [0xccu8; 16],
        peer_name: "Pixel".into(),
        peer_version: 200,
        our_version: 1,
    }) else {
        panic!("IncompatiblePeer must reach the FFI union as itself");
    };
    assert_eq!(data.peer_device_id, "cc".repeat(16));
    assert_eq!(data.peer_name, "Pixel");
    assert_eq!((data.peer_version, data.our_version), (200, 1));
}

/// ensure_compatible refuses on the MAJOR (version / 100), so a peer two
/// majors ahead and a peer one major ahead are both refused -- and the versions
/// that reach the UI must be the raw advertised values, not the major, so the
/// screen can say "they are on 2" rather than a bare "incompatible".
#[test]
fn a_refused_peer_version_is_carried_raw_not_reduced_to_its_major() {
    use daak_core::error::ensure_compatible;
    // The real gate, so this test fails if the gate ever changes under it.
    assert!(ensure_compatible(200).is_err());

    let ev = to_ffi_event(EngineEvent::IncompatiblePeer {
        peer_device_id: [0u8; 16],
        peer_name: "old phone".into(),
        peer_version: 200,
        our_version: 100,
    });
    let json: serde_json::Value = serde_json::from_str(&ffi_event_json(&ev).unwrap()).unwrap();
    assert_eq!(json["peerVersion"], 200);
    assert_eq!(json["ourVersion"], 100);
}
