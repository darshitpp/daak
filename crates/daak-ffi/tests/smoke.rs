use std::sync::Mutex;

use daak_core::crypto::identity::import_from_store;
use daak_core::discovery::PresenceState;
use daak_core::engine::EngineEvent;
use daak_core::pairing::PairingBundle;
use daak_ffi::{to_ffi_event, EventSink, FfiEngine, FfiError, FfiEvent, FileKeyStore};

struct Recorder {
    events: Mutex<Vec<FfiEvent>>,
}

impl EventSink for Recorder {
    fn on_event(&self, event: FfiEvent) {
        self.events.lock().unwrap().push(event);
    }
}

#[test]
fn engine_constructs_and_reports_not_started_instead_of_panicking() {
    // UniFFI 0.28 constructors are infallible: the runtime is built eagerly and
    // the engine itself is not started until start() is called.
    let engine = FfiEngine::new(Box::new(Recorder {
        events: Mutex::new(Vec::new()),
    }));
    assert!(matches!(engine.pairing_bundle(), Err(FfiError::Engine(_))));
    assert!(matches!(engine.list_devices(), Err(FfiError::Engine(_))));
    assert!(matches!(engine.local_port(), Err(FfiError::Engine(_))));
    assert!(matches!(
        engine.send_text("00".repeat(16), "hi".into()),
        Err(FfiError::Engine(_))
    ));
    // A malformed peer id is a protocol error even before the engine is running.
    assert!(matches!(
        engine.cancel("nope".into()),
        Err(FfiError::Protocol(_))
    ));
    // shutdown() on a never-started engine is a no-op, not a panic.
    engine.shutdown().unwrap();
}

#[test]
fn transfer_ids_round_trip_through_hex() {
    let bytes = [
        0u8, 1, 15, 16, 128, 255, 0xab, 0xcd, 0, 0, 0, 0, 0, 0, 0, 0x0f,
    ];
    let s = daak_ffi::to_hex(&bytes);
    assert_eq!(s, "00010f1080ffabcd000000000000000f");
    assert_eq!(daak_ffi::parse_device_id(&s).unwrap(), bytes);
    // Wrong length and non-hex are both protocol errors, not panics.
    assert!(matches!(
        daak_ffi::parse_device_id("abcd"),
        Err(FfiError::Protocol(_))
    ));
    assert!(matches!(
        daak_ffi::parse_device_id("zz"),
        Err(FfiError::Protocol(_))
    ));
}

#[test]
fn identity_persists_across_stores_so_pairing_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let first = import_from_store(&FileKeyStore::new(dir.path().join("keys")).unwrap()).unwrap();
    let second = import_from_store(&FileKeyStore::new(dir.path().join("keys")).unwrap()).unwrap();
    assert_eq!(first.device_id(), second.device_id());
    assert_eq!(first.public(), second.public());
}

#[test]
fn engine_events_map_onto_the_ffi_union_with_hex_ids() {
    let id = [0x11u8; 16];
    let hex = "11".repeat(16);

    // DeviceFound keeps the device identity and address the UI lists.
    let found = to_ffi_event(EngineEvent::DeviceFound(daak_core::DeviceInfo {
        device_id: id,
        name: "Laptop".into(),
        addr: "192.168.1.5:7777".parse().unwrap(),
    }));
    match found {
        FfiEvent::DeviceFound { data } => {
            assert_eq!(data.device_id, hex);
            assert_eq!(data.name, "Laptop");
            assert_eq!(data.addr, "192.168.1.5:7777");
            assert!(data.online);
        }
        other => panic!("expected DeviceFound, got {other:?}"),
    }

    // Presence and DeviceLost both land on DeviceState with opposite polarity.
    let online = to_ffi_event(EngineEvent::Presence {
        device_id: id,
        state: PresenceState::Online,
    });
    assert!(matches!(
        online,
        FfiEvent::DeviceState { data } if data.online && data.device_id == hex
    ));
    let lost = to_ffi_event(EngineEvent::DeviceLost(id));
    assert!(matches!(
        lost,
        FfiEvent::DeviceState { data } if !data.online
    ));

    let progress = to_ffi_event(EngineEvent::TransferProgress {
        transfer_id: id,
        bytes_done: 7,
        bytes_total: 42,
    });
    assert!(matches!(
        progress,
        FfiEvent::TransferProgress { data }
            if data.transfer_id == hex && data.bytes_done == 7 && data.bytes_total == 42
    ));

    let done = to_ffi_event(EngineEvent::TransferDone { transfer_id: id });
    assert!(matches!(
        done,
        FfiEvent::TransferDone { data } if data.transfer_id == hex
    ));

    let failed = to_ffi_event(EngineEvent::TransferFailed {
        transfer_id: id,
        error: "peer went away".into(),
    });
    assert!(matches!(
        failed,
        FfiEvent::TransferFailed { data }
            if data.transfer_id == hex && data.error == "peer went away"
    ));
}

#[test]
fn pairing_bundle_cbor_survives_the_json_string_the_js_layer_parses() {
    let id = daak_core::crypto::identity::Identity::generate().unwrap();
    let bundle = PairingBundle::new(id.public(), "Phone".into());
    let cbor = bundle.to_cbor().unwrap();

    // The JS layer hands the hex cbor straight back to pair_with, so the bytes
    // must survive a hex encode/decode round trip untouched.
    let hex = daak_ffi::to_hex(&cbor);
    let back = hex::decode(&hex).unwrap();
    assert_eq!(back, cbor);
    assert_eq!(PairingBundle::from_cbor(&back).unwrap(), bundle);
}
