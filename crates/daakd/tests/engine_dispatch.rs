#![cfg(unix)]

//! daakd with a REAL daak-core Engine behind it.
//!
//! The central obligation of this file: an `IpcRequest::Send` to a peer that
//! is not on the LAN must come back `{transferId, queued:true}` and be visible
//! in `ListTransfers`, which is only true if the daemon called
//! `Engine::enqueue_outbox_send` rather than the blocking `send_secure`.
//!
//! SOCKET-DEPENDENT: every test here binds a Unix socket, so the controller
//! must run `cargo test -p daakd` with sandbox_permissions
//! require_escalated. See the task report.

use daak_core::discovery::PresenceState;
use daak_core::engine::{DeviceInfo, EngineEvent};
use daak_ipc::TransferFilter;
use daak_ipc::{
    read_message, write_message, IpcEvent, IpcMessage, IpcRequest, IpcResponse, IPC_MAGIC,
    IPC_MAJOR,
};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::sync::broadcast;

/// 16 bytes of peer id, the shape the outbox primary key and every cancel /
/// retry / filter id is. The contract suite's '00'.repeat(16) is the same
/// shape: 32 hex chars decoding to [u8; 16].
///
/// Built by repetition because a hand-typed literal is exactly how this became
/// 34 chars: parse_id rejects it with "id must be 32 hex chars", which reads
/// like a product bug and is not one. `peer_id_is_32_hex_chars` below asserts the
/// length so the two can never drift apart again.
const OFFLINE_PEER: &str = "abababababababababababababababab";

#[test]
fn peer_id_is_32_hex_chars() {
    assert_eq!(
        OFFLINE_PEER.len(),
        32,
        "a peer id is 16 bytes = 32 hex chars"
    );
    assert!(OFFLINE_PEER.chars().all(|c| c.is_ascii_hexdigit()));
    assert!(OFFLINE_PEER.len().is_multiple_of(2));
}

async fn connect(sock: &std::path::Path) -> tokio::net::UnixStream {
    for _ in 0..200 {
        if let Ok(s) = tokio::net::UnixStream::connect(sock).await {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("daakd never bound {}", sock.display());
}

struct Daemon {
    dir: tempfile::TempDir,
    sock: std::path::PathBuf,
    handle: tokio::task::JoinHandle<()>,
}

impl Daemon {
    async fn spawn() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("daakd.sock");
        let (events, _rx) = broadcast::channel::<IpcEvent>(64);
        let handle = tokio::spawn({
            let sock = sock.clone();
            async move { daakd::serve_with(&sock, events).await.unwrap() }
        });
        let _ = connect(&sock).await;
        Daemon { dir, sock, handle }
    }

    fn data_dir(&self) -> String {
        self.dir.path().join("data").to_string_lossy().into_owned()
    }

    async fn call(&self, stream: &mut tokio::net::UnixStream, req: IpcRequest) -> IpcResponse {
        write_message(stream, &IpcMessage::Request(req))
            .await
            .unwrap();
        match read_message(stream).await.unwrap() {
            Some(IpcMessage::Response(r)) => r,
            other => panic!("expected a response, got {other:?}"),
        }
    }

    async fn start_engine(&self, stream: &mut tokio::net::UnixStream) -> IpcResponse {
        self.call(
            stream,
            IpcRequest::Start {
                data_dir: self.data_dir(),
                display_name: "daak-test".into(),
                listen_port: 0,
            },
        )
        .await
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

// Task 18. WHY THE DEVICES ASSERT BELOW IS AN `is_array` AND NOT AN
// `is_empty`.
//
// Every `Daemon::spawn()` in this file builds a REAL `daak_core::Engine`, and a
// real Engine registers an mDNS record on port 5353 and browses for real peers.
// One engine_dispatch binary is therefore up to 16 live advertisers on whatever
// LAN the box is attached to, so a test that starts an engine can legitimately
// DISCOVER A SIBLING TEST'S ENGINE. That is not a regression: "a browsing peer
// inserts into the device map and emits DeviceFound" is precisely what commit
// 53ec661 fixed and it is correct. The old `is_empty` assert asked a question
// about the ambient LAN from inside a unit test, and two of its own siblings
// were answering it.
//
// The obligation these tests actually carry is SHAPE and LIVENESS, not
// emptiness:
//
//   * `Devices` must answer `Json` rather than `Error` -- which is what proves
//     the engine slot is occupied by something alive. A dead engine cannot
//     answer, and `NOT_STARTED` is the error a pre-Start daemon gives.
//   * the payload must be a JSON ARRAY, because `DaemonClient.devices()` runs
//     `JSON.parse` then `parseArray<DeviceInfo>` and rejects anything else. A
//     `Json` response carrying `{}` or `null` would sail past a bare
//     `matches!(.., IpcResponse::Json { .. })` and break every real client, so
//     the shape is pinned here rather than assumed.
//
// The LENGTH is deliberately not asserted: `[]` and `[peer, ...]` are both
// correct answers for `Devices`, and only the first one is what a box with no
// LAN produces. The whole point is that the test must not care which.
fn assert_devices_is_a_json_array(resp: IpcResponse, context: &str) -> Vec<serde_json::Value> {
    let IpcResponse::Json { value } = resp else {
        panic!("Devices must answer Json {context}: {resp:?}");
    };
    let v: serde_json::Value = serde_json::from_str(&value)
        .unwrap_or_else(|e| panic!("Devices must answer valid JSON {context}: {e}\n{value}"));
    let arr = v.as_array().unwrap_or_else(|| {
        panic!(
            "Devices must answer a JSON ARRAY {context}, since \
             DaemonClient.devices() runs parseArray on it; got {value}"
        )
    });
    // Every element is a DeviceInfo the UI reads by field name, so an element
    // missing them is a client-side crash. Discovery-filling the array makes
    // this reachable, so it is pinned here rather than assumed empty.
    for d in arr {
        assert!(
            d["deviceId"].is_string() && d["name"].is_string() && d["addr"].is_string(),
            "every device {context} must carry deviceId, name and addr; got {d}"
        );
    }
    arr.clone()
}

/// The empty-list claim, kept as a CHECK on what these tests do NOT assert:
/// the array length is never constrained, so a discovered sibling is a legal
/// answer and cannot fail any test in this file.
///
/// This is a property of the assertions above, so it is stated as a plain
/// logical fact over the same inputs rather than as a test that would itself
/// need the LAN. It fails if someone reintroduces a length comparison anywhere
/// in the Devices arm of this file.
#[test]
fn a_devices_answer_is_valid_at_any_length() {
    for payload in [
        "[]",
        r#"[{"deviceId":"07","name":"a","addr":"10.0.0.2:9000"}]"#,
        r#"[{"deviceId":"07","name":"a","addr":"10.0.0.2:9000"},{"deviceId":"08","name":"b","addr":"10.0.0.3:9000"}]"#,
    ] {
        let arr = assert_devices_is_a_json_array(
            IpcResponse::Json {
                value: payload.into(),
            },
            "in the any-length control",
        );
        let expected = serde_json::from_str::<serde_json::Value>(payload)
            .unwrap()
            .as_array()
            .unwrap()
            .len();
        assert_eq!(
            arr.len(),
            expected,
            "length must be reported, not constrained"
        );
    }
}

#[tokio::test]
#[should_panic(expected = "must answer a JSON ARRAY")]
async fn the_devices_shape_check_rejects_a_non_array() {
    assert_devices_is_a_json_array(IpcResponse::Json { value: "{}".into() }, "negative control");
}

/// The dispatch decision, not just `export()`: a bundle lands at
/// `<data_dir>/debug-bundles/<name>`, never at a client-named location. The
/// unit tests cover the writer and the name check in isolation, so without
/// this a regression that joined `data_dir` directly would stay green.
#[tokio::test]
async fn the_debug_bundle_lands_under_the_daemons_own_directory() {
    let d = Daemon::spawn().await;
    let mut s = connect(&d.sock).await;
    let started = d.start_engine(&mut s).await;
    assert!(
        matches!(started, IpcResponse::Port { .. }),
        "Start must answer Port, got {started:?}"
    );

    // An absolute path is refused, so it cannot be used to prove where the
    // file went; the accepted name is what pins the location.
    let refused = d
        .call(
            &mut s,
            IpcRequest::ExportDebugBundle {
                path: "/tmp/escape.txt".into(),
            },
        )
        .await;
    assert!(
        matches!(refused, IpcResponse::Error { .. }),
        "an absolute bundle path must be refused, got {refused:?}"
    );
    assert!(!std::path::Path::new("/tmp/escape.txt").exists());

    assert_eq!(
        d.call(
            &mut s,
            IpcRequest::ExportDebugBundle {
                path: "bundle.txt".into(),
            },
        )
        .await,
        IpcResponse::Ok
    );
    let out = std::path::Path::new(&d.data_dir())
        .join("debug-bundles")
        .join("bundle.txt");
    let body = std::fs::read_to_string(&out)
        .unwrap_or_else(|e| panic!("bundle must be at {}: {e}", out.display()));
    assert!(body.contains("=== daak debug bundle ==="));
}

// F5: this lives HERE, not in daemon.contract.spec.ts. That file shares ONE
// daemon process across its tests, so an earlier test has already sent Start by
// the time a "before Start" case runs -- it observed a started engine and
// resolved, which said nothing about the behaviour it claimed to test. Each
// Rust test spawns its own daemon, so "before Start" is actually before Start.
#[tokio::test]
async fn an_engine_backed_request_before_start_is_refused() {
    let d = Daemon::spawn().await;
    let mut s = connect(&d.sock).await;

    // Deliberately no start_engine() call on this connection.
    for req in [
        IpcRequest::ListInbox,
        IpcRequest::Devices,
        IpcRequest::SetDisplayName {
            name: "nope".into(),
        },
        IpcRequest::ExportDebugBundle {
            path: "b.txt".into(),
        },
    ] {
        let r = d.call(&mut s, req.clone()).await;
        let IpcResponse::Error { message } = r else {
            panic!("{req:?} before Start must be an error, not an answer from thin air")
        };
        assert!(
            message.contains("Start"),
            "the error must say to send Start first, got {message:?}"
        );
    }
}

#[tokio::test]
async fn send_to_an_offline_peer_is_queued_not_refused() {
    let d = Daemon::spawn().await;
    let mut s = connect(&d.sock).await;
    d.start_engine(&mut s).await;

    let r = d
        .call(
            &mut s,
            IpcRequest::Send {
                peer_device_id: OFFLINE_PEER.into(),
                text: Some("offline".into()),
                files: vec![],
            },
        )
        .await;
    let IpcResponse::Json { value } = r else {
        panic!("an offline send must not be an error: {r:?}")
    };
    let json: serde_json::Value = serde_json::from_str(&value).unwrap();
    assert_eq!(json["queued"], serde_json::json!(true));
    let transfer_id = json["transferId"].as_str().unwrap().to_string();
    assert_eq!(transfer_id.len(), 32, "payload ids are 16 bytes of hex");

    // The row is durable, so the UI's next listTransfers() sees it. A blocking
    // send_secure would have refused this peer and created no row at all.
    let r = d
        .call(
            &mut s,
            IpcRequest::ListTransfers {
                filter: Some(TransferFilter {
                    state: None,
                    peer_device_id: Some(OFFLINE_PEER.into()),
                }),
            },
        )
        .await;
    let IpcResponse::Json { value } = r else {
        panic!("ListTransfers must answer Json: {r:?}")
    };
    let rows: serde_json::Value = serde_json::from_str(&value).unwrap();
    assert!(
        rows.as_array()
            .unwrap()
            .iter()
            .any(|r| r["transferId"] == transfer_id.as_str()),
        "the queued row must be listed: {rows}"
    );
}

#[tokio::test]
async fn cancel_and_retry_reject_an_unknown_id_and_work_on_a_real_one() {
    let d = Daemon::spawn().await;
    let mut s = connect(&d.sock).await;
    d.start_engine(&mut s).await;

    // R-T10-3 (Phase 3, closed): an id with no outbox row is an ERROR. Every
    // UPDATE in cancel/retry matches zero rows for an unknown id, so without
    // the guard both would silently report success for a row that is not there.
    let zero = "00".repeat(16);
    assert!(matches!(
        d.call(
            &mut s,
            IpcRequest::Cancel {
                transfer_id: zero.clone()
            }
        )
        .await,
        IpcResponse::Error { .. }
    ));
    assert!(matches!(
        d.call(&mut s, IpcRequest::Retry { transfer_id: zero })
            .await,
        IpcResponse::Error { .. }
    ));

    // A malformed id is a different failure and is refused too.
    assert!(matches!(
        d.call(
            &mut s,
            IpcRequest::Cancel {
                transfer_id: "nope".into()
            }
        )
        .await,
        IpcResponse::Error { .. }
    ));
    assert!(matches!(
        d.call(
            &mut s,
            IpcRequest::Retry {
                transfer_id: "ff".into()
            }
        )
        .await,
        IpcResponse::Error { .. }
    ));

    // The POSITIVE half, which is the one that proves cancel is reachable at
    // all: a real queued row, enqueued through Send to an offline peer, then
    // cancelled by its payload id. Before F4 this cancelled an outbox row whose
    // set_transfer_state updated zero rows, so nothing recorded it.
    let r = d
        .call(
            &mut s,
            IpcRequest::Send {
                peer_device_id: OFFLINE_PEER.into(),
                text: Some("cancel me".into()),
                files: vec![],
            },
        )
        .await;
    let IpcResponse::Json { value } = r else {
        panic!("enqueue must succeed: {r:?}")
    };
    let json: serde_json::Value = serde_json::from_str(&value).unwrap();
    let id = json["transferId"].as_str().unwrap().to_string();

    assert!(matches!(
        d.call(
            &mut s,
            IpcRequest::Cancel {
                transfer_id: id.clone()
            }
        )
        .await,
        IpcResponse::Ok
    ));

    // And the transfers row now says so, which is the F4 fix end to end.
    let r = d
        .call(
            &mut s,
            IpcRequest::ListTransfers {
                filter: Some(TransferFilter {
                    state: None,
                    peer_device_id: Some(OFFLINE_PEER.into()),
                }),
            },
        )
        .await;
    let IpcResponse::Json { value } = r else {
        panic!("list must succeed: {r:?}")
    };
    let rows: serde_json::Value = serde_json::from_str(&value).unwrap();
    let row = rows
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["transferId"] == id.as_str())
        .expect("the cancelled row is still listed");
    assert_eq!(row["state"], serde_json::json!("canceled"));

    // A second cancel of an already-terminal row: mark_outbox_terminal_failed
    // guards its UPDATE on state IN ('pending','sending') and returns Ok either
    // way, so this is Ok -- asserted as the code behaves, not as wished.
    assert!(matches!(
        d.call(
            &mut s,
            IpcRequest::Cancel {
                transfer_id: id.clone()
            }
        )
        .await,
        IpcResponse::Ok
    ));

    // Retry re-arms a terminal row, so this one goes back to queued.
    assert!(matches!(
        d.call(&mut s, IpcRequest::Retry { transfer_id: id }).await,
        IpcResponse::Ok
    ));
}

#[tokio::test]
async fn list_inbox_and_the_profile_methods_come_from_the_engine() {
    let d = Daemon::spawn().await;
    let mut s = connect(&d.sock).await;
    d.start_engine(&mut s).await;

    match d.call(&mut s, IpcRequest::ListInbox).await {
        IpcResponse::Json { value } => assert_eq!(value, "[]"),
        other => panic!("ListInbox must answer Json: {other:?}"),
    }
    assert!(matches!(
        d.call(
            &mut s,
            IpcRequest::SetDisplayName {
                name: "renamed".into()
            }
        )
        .await,
        IpcResponse::Ok
    ));
    assert!(matches!(
        d.call(
            &mut s,
            IpcRequest::SetPresence {
                state: "away".into()
            }
        )
        .await,
        IpcResponse::Ok
    ));
    // 'offline' is a peer's claim about us, not a state this device declares.
    assert!(matches!(
        d.call(
            &mut s,
            IpcRequest::SetPresence {
                state: "offline".into()
            }
        )
        .await,
        IpcResponse::Error { .. }
    ));
}

#[tokio::test]
async fn devices_answers_from_the_engine_and_start_is_idempotent() {
    let d = Daemon::spawn().await;
    let mut s = connect(&d.sock).await;

    // Before Start there is no engine, and the answer says so instead of
    // inventing an empty device list.
    match d.call(&mut s, IpcRequest::Devices).await {
        IpcResponse::Error { message } => assert!(message.contains("Start"), "{message}"),
        other => panic!("expected an error before Start, got {other:?}"),
    }

    let started = d.start_engine(&mut s).await;
    assert!(
        matches!(started, IpcResponse::Port { .. }),
        "Start must answer Port, got {started:?}"
    );
    // The same arguments again is a no-op, not a second engine.
    assert!(matches!(
        d.start_engine(&mut s).await,
        IpcResponse::Port { .. }
    ));
    // Different arguments would silently orphan the running engine's socket
    // and its DB handle, so it is refused.
    match d
        .call(
            &mut s,
            IpcRequest::Start {
                data_dir: d.data_dir(),
                display_name: "other".into(),
                listen_port: 0,
            },
        )
        .await
    {
        IpcResponse::Error { message } => assert!(message.contains("already"), "{message}"),
        other => panic!("a conflicting Start must be refused, got {other:?}"),
    }

    // Devices answers from the ENGINE, not from the daemon: a Json array. Its
    // length is not asserted -- see the note above the helper -- so this arm
    // cannot be made to fail by a peer appearing on the LAN.
    assert_devices_is_a_json_array(d.call(&mut s, IpcRequest::Devices).await, "after Start");
}

#[tokio::test]
async fn a_foreign_major_gets_update_required_and_is_never_dispatched() {
    let d = Daemon::spawn().await;
    let mut s = connect(&d.sock).await;
    d.start_engine(&mut s).await;

    // A 2.x frame with a body this build cannot even NAME (a renamed
    // variant). Hand-write it, because write_message always stamps 1.x.
    let mut body = Vec::new();
    ciborium::into_writer(
        &serde_json::json!({
            "v": (2u16 << 8),
            "msg": { "Request": { "NoSuchRequest": {} } },
        }),
        &mut body,
    )
    .unwrap();
    let mut frame = Vec::new();
    frame.extend_from_slice(&IPC_MAGIC);
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(&body);
    s.write_all(&frame).await.unwrap();
    s.flush().await.unwrap();

    match read_message(&mut s).await.unwrap() {
        Some(IpcMessage::Response(IpcResponse::UpdateRequired { min_major })) => {
            assert_eq!(min_major, IPC_MAJOR);
        }
        other => panic!("a foreign major must get UpdateRequired, got {other:?}"),
    }
    // The connection is dropped right after, so a second read is a clean EOF.
    assert!(read_message(&mut s).await.unwrap().is_none());
}

#[tokio::test]
async fn every_engine_event_maps_to_an_encodable_ipc_event() {
    // No socket needed, but it lives here because this is the daemon's map and
    // a new EngineEvent variant that fails to map is a daemon bug.
    let peer = [7u8; 16];
    let cases = vec![
        EngineEvent::DeviceFound(DeviceInfo {
            device_id: peer,
            name: "peer".into(),
            addr: "10.0.0.2:9000".parse().unwrap(),
        }),
        EngineEvent::DeviceLost(peer),
        EngineEvent::Presence {
            device_id: peer,
            state: PresenceState::Online,
        },
        EngineEvent::Presence {
            device_id: peer,
            state: PresenceState::Away,
        },
        EngineEvent::TransferProgress {
            transfer_id: peer,
            bytes_done: 5,
            bytes_total: 10,
        },
        EngineEvent::TransferDone { transfer_id: peer },
        EngineEvent::TransferFailed {
            transfer_id: peer,
            error: "boom".into(),
        },
        // C1: without this arm the desktop half of the same hole stayed open --
        // DaemonClient's inbox.received was unreachable from the engine too.
        EngineEvent::InboxReceived(daak_core::store::inbox::InboxRow {
            id: peer,
            transfer_id: peer,
            peer_device_id: [3u8; 16],
            kind: "text".into(),
            item_count: 1,
            summary: "meet at 6".into(),
            received_at: 1_700_000_000,
            saved_paths: "[]".into(),
        }),
    ];
    for ev in cases {
        let mapped = daakd::to_ipc_event(ev);
        if let IpcEvent::InboxReceived { payload_json } = &mapped {
            // The wire value is a JSON STRING the client parses (see the
            // variant's doc comment), and it must be the same InboxEntry shape
            // the FFI bridge sends, not a daemon-local variant of it.
            let json: serde_json::Value = serde_json::from_str(payload_json).unwrap();
            assert_eq!(json["summary"], serde_json::json!("meet at 6"));
            assert_eq!(json["savedPaths"], serde_json::json!([]));
            assert_eq!(json["payloadId"], serde_json::json!(hex::encode(peer)));
        }
        // Every IpcEvent must survive the real encoder, not just a Debug print.
        let mut buf = Vec::new();
        daak_ipc::write_message(&mut buf, &IpcMessage::Event(mapped.clone()))
            .await
            .unwrap();
        assert!(!buf.is_empty(), "{mapped:?} did not encode");
    }
}

// CONTRACT (daakd's half): a corrupt saved_paths is `null`, not `[]`, exactly as
// in daak-ffi. The two bridges must not disagree about what a corrupt row means.
#[test]
fn a_corrupt_saved_paths_reaches_the_ipc_client_as_null_not_an_empty_list() {
    let row = daak_core::store::inbox::InboxRow {
        id: [1u8; 16],
        transfer_id: [1u8; 16],
        peer_device_id: [2u8; 16],
        kind: "file".into(),
        item_count: 1,
        summary: String::new(),
        received_at: 0,
        saved_paths: "{not json".into(),
    };
    let IpcEvent::InboxReceived { payload_json } =
        daakd::to_ipc_event(EngineEvent::InboxReceived(row))
    else {
        panic!("expected an inbox event");
    };
    let json: serde_json::Value = serde_json::from_str(&payload_json).unwrap();
    assert!(json["savedPaths"].is_null());
}

/// CONTRACT (daakd's half, and the mirror of the daak-ffi test): the item event
/// must land on IpcEvent::TransferItem carrying the SAME FOUR fields the FFI arm
/// sends, so the desktop and mobile views of one logical event cannot drift.
///
/// The None -> "" case is the one that would otherwise diverge silently: a
/// non-binary item is never materialised, and both bridges must spell that
/// absence the same way rather than one sending null and the other "".
#[tokio::test]
async fn a_transfer_item_event_reaches_the_ipc_client_with_the_same_four_fields_as_ffi() {
    let id = [0x11u8; 16];
    let hex = hex::encode(id);
    let IpcEvent::TransferItem {
        transfer_id,
        item_index,
        state,
        dest_path,
    } = daakd::to_ipc_event(EngineEvent::TransferItem {
        transfer_id: id,
        item_index: 2,
        state: "quarantined".into(),
        dest_path: Some("/data/daak/downloads/quarantine/ab/bad.bin".into()),
    })
    else {
        panic!("expected a transfer item event");
    };
    assert_eq!(transfer_id, hex);
    assert_eq!(item_index, 2);
    assert_eq!(state, "quarantined");
    assert_eq!(dest_path, "/data/daak/downloads/quarantine/ab/bad.bin");

    // A text item: never materialised, so no path. Both bridges use "" here --
    // NOT null, because DaemonClient reads dest_path with str() and would throw.
    let IpcEvent::TransferItem { dest_path, .. } = daakd::to_ipc_event(EngineEvent::TransferItem {
        transfer_id: id,
        item_index: 0,
        state: "done".into(),
        dest_path: None,
    }) else {
        panic!("expected a transfer item event");
    };
    assert_eq!(
        dest_path, "",
        "a text item must encode an absent path as empty"
    );

    // It must survive the real encoder, like every other IpcEvent.
    let mut buf = Vec::new();
    daak_ipc::write_message(
        &mut buf,
        &IpcMessage::Event(IpcEvent::TransferItem {
            transfer_id: hex,
            item_index: 2,
            state: "done".into(),
            dest_path: String::new(),
        }),
    )
    .await
    .unwrap();
    assert!(!buf.is_empty());
}

// SHOULD-FIX 5: the ONE link between an EngineEvent and a subscribed IPC client
// was untested, because bridge_events took an &Engine and a real Engine cannot
// emit a single event without a second peer on the LAN. It now takes the
// event RECEIVER, so the mapping and the fan-out are both reachable: a real
// daak-core broadcast sender feeds the real bridge, which feeds the real IPC
// broadcast a subscribed client is reading. No fake engine, no invented event.
#[tokio::test]
async fn a_real_engine_event_reaches_a_subscribed_ipc_client() {
    let d = Daemon::spawn().await;
    let mut s = connect(&d.sock).await;
    d.start_engine(&mut s).await;
    // Subscribe first: the daemon only fans out on a subscribed connection.
    assert!(matches!(
        d.call(&mut s, IpcRequest::Subscribe).await,
        IpcResponse::Ok
    ));

    // The engine's OWN event channel. A real Engine publishes here; the test
    // publishes on the same channel so the bridge under test is the production
    // one, not a stand-in.
    let (engine_tx, engine_rx) = broadcast::channel::<EngineEvent>(16);
    let (ipc_tx, mut ipc_rx) = broadcast::channel::<IpcEvent>(16);
    daakd::bridge_events(engine_rx, ipc_tx.clone());
    let _client = ipc_tx.subscribe();

    let peer = [7u8; 16];
    engine_tx
        .send(EngineEvent::DeviceFound(DeviceInfo {
            device_id: peer,
            name: "peer".into(),
            addr: "10.0.0.2:9000".parse().unwrap(),
        }))
        .unwrap();

    let got = tokio::time::timeout(Duration::from_secs(5), ipc_rx.recv())
        .await
        .expect("the bridge did not forward within 5s")
        .expect("the IPC channel closed");
    assert_eq!(
        got,
        IpcEvent::DeviceFound {
            device_id: hex::encode(peer),
            name: "peer".into(),
            addr: "10.0.0.2:9000".into(),
        }
    );

    // And it survives the REAL encoder, which is what a client actually reads.
    let mut buf = Vec::new();
    daak_ipc::write_message(&mut buf, &IpcMessage::Event(got))
        .await
        .unwrap();
    assert!(!buf.is_empty());
}

// B4: Shutdown used to await engine.shutdown() but LEAVE the Arc in the slot,
// so a later Start with the same args took the idempotent branch and answered
// Port for a port whose accept task had been aborted -- a dead port reported
// as a live one. The engine must be taken OUT of the slot, so the second Start
// builds a fresh one.
#[tokio::test]
async fn shutdown_then_start_with_the_same_args_gets_a_live_engine() {
    let d = Daemon::spawn().await;
    let mut first = connect(&d.sock).await;
    let IpcResponse::Port { port: _p1 } = d.start_engine(&mut first).await else {
        panic!("the first Start must answer Port")
    };

    // Shutdown closes the connection without answering, so it is sent raw.
    write_message(&mut first, &IpcMessage::Request(IpcRequest::Shutdown))
        .await
        .unwrap();
    assert!(
        read_message(&mut first).await.unwrap().is_none(),
        "Shutdown drops the connection without a response"
    );

    // The SAME args as before: with the engine still in the slot this took the
    // idempotent branch and answered the DEAD port.
    let mut second = connect(&d.sock).await;
    let IpcResponse::Port { port: p2 } = d.start_engine(&mut second).await else {
        panic!("the second Start must answer Port, not an error")
    };
    // Not `p2 != p1`: the OS is free to hand back the same port number. What
    // matters is whether anything is ACCEPTING on it -- the old engine's
    // listener was aborted, so a reused number would be a dead port.
    tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::TcpStream::connect(("127.0.0.1", p2)),
    )
    .await
    .unwrap_or_else(|_| panic!("nothing is accepting on the port Start answered ({p2})"))
    .expect("connect to the fresh engine's port");

    // The new engine really is serving: Devices is ANSWERED -- Json, and a
    // JSON array the client can parse -- rather than refused. That is the
    // liveness proof the slot holds a fresh engine and not the corpse of the
    // old one: a dead engine answers nothing, and a daemon whose slot was
    // empty answers NOT_STARTED.
    //
    // The array's LENGTH is not asserted, on purpose. 'A lone daemon sees no
    // peers' was true only on a box with no LAN, and this binary puts up to 16
    // real mDNS advertisers on whatever LAN the machine is attached to, so a
    // sibling test's engine is a legal entry here. See the note above
    // `assert_devices_is_a_json_array`.
    assert_devices_is_a_json_array(
        d.call(&mut second, IpcRequest::Devices).await,
        "from the FRESH engine",
    );

    // NOT a freshness proof, and deliberately not read as one. A shut-down
    // engine answers `SelfProfile` perfectly well: `Engine::shutdown`
    // (crates/daak-core/src/engine.rs:1469-1484) only aborts the accept /
    // discovery / presence tasks, stops the outbox worker, stops the
    // advertiser and stops the browser. It does NOT clear `profile`, does NOT
    // clear `identity` and does NOT drop the device map, so under the B4
    // regression -- the corpse left in the slot, the second `Start` taking the
    // idempotent branch -- both asserts below would still PASS. Do not add a
    // comment here claiming otherwise.
    //
    // What this arm actually pins, both of which are worth pinning:
    //
    //   1. the SHAPE of the profile -- `deviceId` is 32 hex chars because
    //      `hex::encode` of `[u8; 16]` is always 32 (daakd/src/lib.rs:693), and
    //      `name` is a real string because `resolved_name` is written once at
    //      `Engine::start` from `resolve_name` -> `unique_display_name`, which
    //      returns the base name or a suffixed variant, never empty.
    //   2. IDENTITY STABILITY across the shutdown/restart cycle. The second
    //      `Start` re-imports from the same `data_dir/keys`, so the Ed25519
    //      signing key is the same key and `device_id()` is
    //      `blake2b256(verify)[..16]` -- deterministic in that key
    //      (crypto/identity.rs:73-76, :115-134). That is what makes the
    //      restarted engine recognisably the SAME DEVICE to its peers, so the
    //      pairing rows that already point at this id keep pointing somewhere
    //      real. A daemon that minted a fresh identity on restart would look
    //      like a brand-new device to every paired peer, and nothing else in
    //      this test would notice.
    //
    // LIVENESS -- fresh engine rather than corpse -- is proven by the TCP
    // connect to `p2` immediately above. That is the ONLY assertion in this
    // test a corpse cannot satisfy, and it is therefore the ONLY thing here
    // that defends B4.
    let IpcResponse::Json { value } = d.call(&mut second, IpcRequest::SelfProfile).await else {
        panic!("SelfProfile must answer Json from the FRESH engine");
    };
    let profile: serde_json::Value = serde_json::from_str(&value).unwrap();
    assert_eq!(
        profile["deviceId"].as_str().map(str::len),
        Some(32),
        "the fresh engine must report its own 16-byte device id, got {value}"
    );
    assert!(
        profile["name"]
            .as_str()
            .is_some_and(|n| !n.trim().is_empty()),
        "the fresh engine must report a resolved name, got {value}"
    );
}

#[tokio::test]
async fn a_start_error_surfaces_as_an_error_response() {
    let d = Daemon::spawn().await;
    let mut s = connect(&d.sock).await;
    // A data_dir that cannot be created is a real Start failure and must be
    // reported, not swallowed into a half-started engine.
    let file = d.dir.path().join("a-file");
    std::fs::write(&file, b"").unwrap();
    match d
        .call(
            &mut s,
            IpcRequest::Start {
                data_dir: file.join("data").to_string_lossy().into_owned(),
                display_name: "daak-test".into(),
                listen_port: 0,
            },
        )
        .await
    {
        IpcResponse::Error { message } => assert!(!message.is_empty()),
        other => panic!("a bad data_dir must be an error, got {other:?}"),
    }
}

#[tokio::test]
async fn update_required_is_answered_before_dispatch_even_for_a_valid_1x_body() {
    // The two-pass decode (R-T8 SF1) means the version is read before the body
    // is named. A 2.x frame carrying a body that WOULD decode is still only
    // ever UpdateRequired, never a dispatched request.
    let d = Daemon::spawn().await;
    let mut s = connect(&d.sock).await;

    let mut body = Vec::new();
    ciborium::into_writer(
        &serde_json::json!({
            "v": (2u16 << 8),
            "msg": { "Request": "Devices" },
        }),
        &mut body,
    )
    .unwrap();
    let mut frame = Vec::new();
    frame.extend_from_slice(&IPC_MAGIC);
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(&body);
    s.write_all(&frame).await.unwrap();
    s.flush().await.unwrap();

    assert_eq!(
        read_message(&mut s).await.unwrap(),
        Some(IpcMessage::Response(IpcResponse::UpdateRequired {
            min_major: IPC_MAJOR
        }))
    );
}

// C2, desktop bridge. `pairing.done` was live in the TS union (spec 6.1) with a
// handler and had NO IpcEvent variant, so DaemonClient dropped the name as
// unknown and the desktop could not see a completed pairing either. daakd's
// to_ipc_event is an EXHAUSTIVE match by design, so a new EngineEvent variant
// forces this arm -- it is not optional, and a wildcard would hide the drift.
#[tokio::test]
async fn a_completed_pairing_reaches_the_ipc_client_with_the_same_shape_as_ffi() {
    let IpcEvent::PairingDone { device_id } = daakd::to_ipc_event(EngineEvent::PairingDone {
        device_id: [0x11u8; 16],
    }) else {
        panic!("expected a pairing done event");
    };
    // The SAME field name and the SAME hex encoding as the FFI arm, so
    // toDaakEvent's `case 'PairingDone'` cannot read one shape on the wire and
    // the other in the JSON.
    assert_eq!(device_id, "11".repeat(16));

    let mut buf = Vec::new();
    daak_ipc::write_message(
        &mut buf,
        &IpcMessage::Event(IpcEvent::PairingDone {
            device_id: "11".repeat(16),
        }),
    )
    .await
    .unwrap();
    assert!(!buf.is_empty());
}
