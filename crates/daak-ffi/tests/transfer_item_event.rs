use daak_core::engine::EngineEvent;
use daak_ffi::{ffi_event_json, to_ffi_event, FfiEvent};

/// R116, step 4: ffi_event_json already had a TransferItem arm and must be
/// LEFT ALONE. This test pins the JSON contract that arm produces, so the day
/// somebody "fixes" it the four keys change here first. The key set is what
/// packages/core/src/engine/DaemonClient.ts:241-248 and the TS union read, so
/// it is compared as a SET: serde_json orders object keys.
#[test]
fn transfer_item_json_carries_exactly_the_four_keys_the_ts_union_reads() {
    let ev = to_ffi_event(EngineEvent::TransferItem {
        transfer_id: [0x11u8; 16],
        item_index: 2,
        state: "done".into(),
        dest_path: Some("/data/daak/downloads/movie.mov".into()),
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
        vec!["destPath", "itemIndex", "state", "transferId", "type"]
    );
    assert_eq!(json["type"], "transfer.item");
    assert_eq!(json["transferId"], "11".repeat(16));
    assert_eq!(json["itemIndex"], 2);
    assert_eq!(json["state"], "done");
    assert_eq!(json["destPath"], "/data/daak/downloads/movie.mov");
}

/// A TEXT item is never materialised, so dest_path is None on the Rust side
/// while TransferItemEvent.dest_path is a plain (non-optional) string. The
/// file's own convention for an absent string is the empty one -- to_pairing_sas_event
/// (lib.rs:684) uses String::new() for exactly this -- and DaemonClient reads
/// it with str(), which would fail on a null. So None maps to "", never "null".
#[test]
fn a_none_dest_path_maps_to_the_empty_string_not_json_null() {
    let FfiEvent::TransferItem { data } = to_ffi_event(EngineEvent::TransferItem {
        transfer_id: [0x22u8; 16],
        item_index: 0,
        state: "done".into(),
        dest_path: None,
    }) else {
        panic!("expected a transfer item event");
    };
    assert_eq!(data.dest_path, "");

    let json: serde_json::Value =
        serde_json::from_str(&ffi_event_json(&FfiEvent::TransferItem { data }).unwrap()).unwrap();
    assert_eq!(
        json["destPath"],
        serde_json::json!(""),
        "a null would break str() in DaemonClient"
    );
}
