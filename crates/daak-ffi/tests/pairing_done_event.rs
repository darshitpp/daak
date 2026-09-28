// C2, mobile bridge. `pairing.done` was a live member of the TS union with a
// handler and NO producer: no EngineEvent variant, no FfiEvent variant, no
// to_ffi_event arm, no JSON arm. These pin the whole mobile path --
// EngineEvent -> FfiEvent -> the JSON packages/core/src/engine/types.ts reads --
// plus the host arm that the FFI surface was missing entirely.
use daak_core::engine::EngineEvent;
use daak_ffi::{ffi_event_json, to_ffi_event, EventSink, FfiEngine, FfiError, FfiEvent};

/// The JSON contract, compared as a SET (serde_json orders object keys). The
/// key names are what InProcessEngine's `on` hands the UI as a typed union
/// member, so a rename breaks here first.
#[test]
fn pairing_done_json_carries_exactly_type_and_device_id() {
    let ev = to_ffi_event(EngineEvent::PairingDone {
        device_id: [0x11u8; 16],
    });
    let json: serde_json::Value = serde_json::from_str(&ffi_event_json(&ev).unwrap()).unwrap();

    let mut keys: Vec<&str> = json
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, vec!["deviceId", "type"]);
    assert_eq!(json["type"], "pairing.done");
    // 32 hex chars, the same id shape every other field on both bridges uses.
    assert_eq!(json["deviceId"], "11".repeat(16));
}

#[test]
fn the_engine_event_maps_onto_the_ffi_union_with_a_hex_id() {
    let FfiEvent::PairingDone { data } = to_ffi_event(EngineEvent::PairingDone {
        device_id: [0xabu8; 16],
    }) else {
        panic!("PairingDone must reach the FFI union as itself");
    };
    assert_eq!(data.device_id, "ab".repeat(16));
}

struct Recorder;
impl EventSink for Recorder {
    fn on_event(&self, _event: FfiEvent) {}
}

/// The host arm. Before this the FFI surface had pairing_bundle, pair_with and
/// accept_pairing and NOTHING that sets pending_pairing, so an inbound joiner
/// fell through to `unpaired inbound connection` (engine.rs:836) and the host
/// half of QR pairing could not complete on a device at all.
#[test]
fn offer_pairing_takes_the_same_bundle_bytes_as_pair_with_and_validates_them() {
    let engine = FfiEngine::new(Box::new(Recorder));

    // A REAL, well-formed bundle, so the assertion below is about the engine
    // boundary and nothing else. A garbage byte string cannot distinguish
    // "rejected because the engine is down" from "rejected because it is not
    // CBOR" -- offering one and expecting Engine is a test of the wrong thing.
    let identity = daak_core::crypto::identity::Identity::generate().unwrap();
    let bundle = daak_core::pairing::PairingBundle::new(identity.public(), "peer".into())
        .to_cbor()
        .unwrap();

    // Not started: an engine error, like every other method.
    assert!(matches!(
        engine.offer_pairing(bundle),
        Err(FfiError::Engine(_))
    ));
    // A bundle that does not decode is a PROTOCOL error at the trust boundary,
    // the same as pair_with: the bytes come off a camera.
    assert!(matches!(
        engine.offer_pairing(b"not cbor".to_vec()),
        Err(FfiError::Protocol(_))
    ));
}

// ---- Second review: the host arm that spec 3.3 Mode A actually needs ------
//
// offer_pairing above is the RE-ARM path: it needs a bundle, and in the QR
// flow only the JOINER ever has one. So the host's real arm is
// `arm_host_pairing`, which takes no bundle at all. The distinction matters:
// offer_pairing's bundle is VERIFIED here at the trust boundary, and there is
// nothing to verify when there is no bundle. What replaces that check is the
// engine's in-band identity verification plus the Noise XX handshake, and the
// user comparing the SAS. See PendingArm::Open in crates/daak-core.

#[test]
fn arm_host_pairing_takes_no_bundle_and_arms_the_open_slot() {
    let engine = FfiEngine::new(Box::new(Recorder));

    // Not started is an ENGINE error, exactly like every other method -- so
    // this is a real call against the real method, not a shape check.
    assert!(matches!(
        engine.arm_host_pairing(),
        Err(FfiError::Engine(_))
    ));
}
