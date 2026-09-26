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
    // Inbound pairing is reachable only through accept_pairing; before start()
    // there is no pairing channel, and it says so instead of blocking.
    assert!(matches!(engine.accept_pairing(), Err(FfiError::Engine(_))));
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
    assert_eq!(daak_ffi::parse_id(&s).unwrap(), bytes);
    // Wrong length and non-hex are both protocol errors, not panics.
    assert!(matches!(
        daak_ffi::parse_id("abcd"),
        Err(FfiError::Protocol(_))
    ));
    assert!(matches!(
        daak_ffi::parse_id("zz"),
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

    // The JS layer reads these keys and hands the hex cbor straight back to
    // pair_with, so the key set is the contract: {cbor, name, device_id}.
    let json: serde_json::Value =
        serde_json::from_str(&daak_ffi::pairing_bundle_json(&bundle).unwrap()).unwrap();
    // serde_json orders object keys, so compare the SET, not the order.
    let mut keys: Vec<&str> = json
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, ["cbor", "device_id", "name"]);
    assert_eq!(json["name"], serde_json::json!("Phone"));
    assert_eq!(
        json["device_id"],
        serde_json::json!(daak_ffi::to_hex(&id.public().device_id))
    );

    let back = hex::decode(json["cbor"].as_str().unwrap()).unwrap();
    assert_eq!(PairingBundle::from_cbor(&back).unwrap(), bundle);
}

#[test]
fn an_inbound_pairing_sas_reaches_js_as_a_pairing_sas_event() {
    // The core only surfaces the SAS string for an inbound pairing, so the
    // event carries no peer id and the SAS is what JS must show the user.
    match daak_ffi::to_pairing_sas_event("123456".into()) {
        FfiEvent::PairingSas { data } => {
            assert_eq!(data.sas, "123456");
            assert!(data.peer_device_id.is_empty());
        }
        other => panic!("expected PairingSas, got {other:?}"),
    }
}

/// The JSON the native modules forward over the DaakEvent channel. The key set
/// IS the contract with packages/core/src/engine/types.ts -- the other end of
/// it -- so assert the exact keys, not just that it serialises.
fn keys_of(ev: &FfiEvent) -> Vec<String> {
    let json: serde_json::Value =
        serde_json::from_str(&daak_ffi::ffi_event_json(ev).unwrap()).unwrap();
    let mut keys: Vec<String> = json.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    keys
}

#[test]
fn ffi_event_json_carries_the_frozen_ts_daak_event_keys() {
    let hex = "ab".repeat(16);

    // device.discovered nests the device, unlike every other variant.
    let found = FfiEvent::DeviceFound {
        data: daak_ffi::DeviceFoundEvent {
            device_id: hex.clone(),
            name: "Laptop".into(),
            addr: "192.168.1.5:7777".into(),
            online: true,
        },
    };
    assert_eq!(keys_of(&found), ["device", "type"].map(String::from));
    let json: serde_json::Value =
        serde_json::from_str(&daak_ffi::ffi_event_json(&found).unwrap()).unwrap();
    assert_eq!(json["type"], "device.discovered");
    assert_eq!(json["device"]["deviceId"], serde_json::json!(hex));
    assert_eq!(json["device"]["online"], serde_json::json!(true));
    // The nested object is a DeviceInfo in TS, so its key set is fixed too.
    let mut device_keys: Vec<String> = json["device"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    device_keys.sort();
    assert_eq!(
        device_keys,
        ["addr", "deviceId", "name", "online"].map(String::from)
    );

    // device.state flips one string, never a boolean, so JS can switch on it.
    for (online, expected) in [(true, "online"), (false, "offline")] {
        let ev = FfiEvent::DeviceState {
            data: daak_ffi::DeviceStateEvent {
                device_id: hex.clone(),
                online,
            },
        };
        assert_eq!(
            keys_of(&ev),
            ["deviceId", "state", "type"].map(String::from)
        );
        let json: serde_json::Value =
            serde_json::from_str(&daak_ffi::ffi_event_json(&ev).unwrap()).unwrap();
        assert_eq!(json["type"], "device.state");
        assert_eq!(json["deviceId"], serde_json::json!(hex));
        assert_eq!(json["state"], serde_json::json!(expected));
    }

    let progress = FfiEvent::TransferProgress {
        data: daak_ffi::ProgressEvent {
            transfer_id: hex.clone(),
            bytes_done: 7,
            bytes_total: 42,
        },
    };
    assert_eq!(
        keys_of(&progress),
        ["bytesDone", "bytesTotal", "transferId", "type"].map(String::from)
    );
    let json: serde_json::Value =
        serde_json::from_str(&daak_ffi::ffi_event_json(&progress).unwrap()).unwrap();
    assert_eq!(json["type"], "transfer.progress");
    assert_eq!(json["transferId"], serde_json::json!(hex));
    assert_eq!(json["bytesDone"], serde_json::json!(7));
    assert_eq!(json["bytesTotal"], serde_json::json!(42));

    // The rest are pinned too, so no variant can drift silently.
    assert_eq!(
        keys_of(&FfiEvent::PairingSas {
            data: daak_ffi::PairingSasEvent {
                peer_device_id: hex.clone(),
                sas: "123456".into(),
            },
        }),
        ["peerDeviceId", "sas", "type"].map(String::from)
    );
    assert_eq!(
        keys_of(&FfiEvent::TransferItem {
            data: daak_ffi::TransferItemEvent {
                transfer_id: hex.clone(),
                item_index: 2,
                state: "receiving".into(),
                dest_path: "/tmp/a".into(),
            },
        }),
        ["destPath", "itemIndex", "state", "transferId", "type"].map(String::from)
    );
    assert_eq!(
        keys_of(&FfiEvent::TransferDone {
            data: daak_ffi::DoneEvent {
                transfer_id: hex.clone(),
            },
        }),
        ["transferId", "type"].map(String::from)
    );
    assert_eq!(
        keys_of(&FfiEvent::TransferFailed {
            data: daak_ffi::FailedEvent {
                transfer_id: hex.clone(),
                error: "peer went away".into(),
            },
        }),
        ["error", "transferId", "type"].map(String::from)
    );

    // Queued reuses transfer.done: the TS union has no transfer.queued, because
    // a queued send is a send() return value, not an event.
    let queued_json = daak_ffi::ffi_event_json(&FfiEvent::TransferQueued {
        data: daak_ffi::DoneEvent {
            transfer_id: hex.clone(),
        },
    })
    .unwrap();
    assert!(queued_json.contains("transfer.done"));
    assert!(!queued_json.contains("transfer.queued"));
}

#[test]
fn inbox_received_parses_its_payload_string_rather_than_nesting_it() {
    // The engine hands over a JSON string; TS types it as an object, so the
    // adapter must splice in the parsed value, not a stringified blob.
    let ev = FfiEvent::InboxReceived {
        data: daak_ffi::InboxReceivedEvent {
            payload_json: r#"{"payloadId":"ab","itemCount":2}"#.into(),
        },
    };
    let json: serde_json::Value =
        serde_json::from_str(&daak_ffi::ffi_event_json(&ev).unwrap()).unwrap();
    assert_eq!(json["type"], "inbox.received");
    assert_eq!(json["payload"]["payloadId"], serde_json::json!("ab"));
    assert_eq!(json["payload"]["itemCount"], serde_json::json!(2));
}
