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

    assert!(matches!(
        d.start_engine(&mut s).await,
        IpcResponse::Port { .. }
    ));
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

    match d.call(&mut s, IpcRequest::Devices).await {
        IpcResponse::Json { value } => {
            let v: serde_json::Value = serde_json::from_str(&value).unwrap();
            assert!(
                v.as_array().unwrap().is_empty(),
                "a lone daemon sees no peers"
            );
        }
        other => panic!("Devices must answer Json after Start: {other:?}"),
    }
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
    ];
    for ev in cases {
        let mapped = daakd::to_ipc_event(ev);
        // Every IpcEvent must survive the real encoder, not just a Debug print.
        let mut buf = Vec::new();
        daak_ipc::write_message(&mut buf, &IpcMessage::Event(mapped.clone()))
            .await
            .unwrap();
        assert!(!buf.is_empty(), "{mapped:?} did not encode");
    }
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
