use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum IpcMessage {
    Request(IpcRequest),
    Response(IpcResponse),
    Event(IpcEvent),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum IpcRequest {
    Start {
        data_dir: String,
        display_name: String,
        listen_port: u16,
    },
    Subscribe,
    Devices,
    Pair {
        addr: String,
        bundle_cbor: Vec<u8>,
    },
    Send {
        peer_device_id: String,
        text: Option<String>,
        files: Vec<String>,
    },
    Cancel {
        transfer_id: String,
    },
    Retry {
        transfer_id: String,
    },
    ListTransfers,
    ListInbox,
    SetDisplayName {
        name: String,
    },
    SetPresence {
        state: String,
    },
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum IpcResponse {
    Ok,
    Error {
        message: String,
    },
    Json {
        value: String,
    },
    Port {
        port: u16,
    },
    /// The peer's frame major is not one we implement. `min_major` is the
    /// lowest major this side understands, so an old client knows what to
    /// fetch. Answered before any request is dispatched.
    UpdateRequired {
        min_major: u16,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum IpcEvent {
    DeviceFound {
        device_id: String,
        name: String,
        addr: String,
    },
    DeviceState {
        device_id: String,
        online: bool,
    },
    PairingSas {
        peer_device_id: String,
        sas: String,
    },
    TransferProgress {
        transfer_id: String,
        bytes_done: u64,
        bytes_total: u64,
    },
    TransferItem {
        transfer_id: String,
        item_index: u32,
        state: String,
        dest_path: String,
    },
    TransferDone {
        transfer_id: String,
    },
    TransferFailed {
        transfer_id: String,
        error: String,
    },
    /// `payload_json` is a raw JSON STRING, not an InboxEntry: the daemon does
    /// not parse it, and the client must JSON.parse it before handing the event
    /// to TS, which types it as an object. The name says so on purpose.
    InboxReceived {
        payload_json: String,
    },
}

/// The whole frame: a schema version plus the message. `#[serde(default)]` and
/// the ABSENCE of `deny_unknown_fields` are load-bearing -- together they are
/// what let a frame from a newer 1.x peer decode instead of erroring.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IpcFrame {
    #[serde(default)]
    pub v: u16,
    pub msg: IpcMessage,
}

/// The IPC schema version this build speaks. HIGH byte = major, low byte =
/// minor, so 1.0 is 0x0100 = 256. A peer is compatible when
/// `(v >> 8) == IPC_MAJOR`: a newer MINOR is accepted (additive fields live
/// there), a different MAJOR is refused.
pub const IPC_MAJOR: u16 = 1;
pub const IPC_MINOR: u16 = 0;
pub const IPC_VERSION: u16 = (IPC_MAJOR << 8) | IPC_MINOR;

#[derive(Debug, thiserror::Error)]
pub enum IpcError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("cbor: {0}")]
    Cbor(String),
    #[error("update required: this build speaks IPC major {IPC_MAJOR}, the peer needs at least {min_major}")]
    UpdateRequired { min_major: u16 },
}

/// Local IPC magic (spec §6.3). Every message is
/// `DAAK` + u32 BE length + CBOR({"v": version, "msg": IpcMessage}).
/// The wire layout is schema-checked against proto/ipc.cddl by
/// crates/daak-ipc/tests/schema.rs.
///
/// `read_message` returns Ok(None) when the peer disconnects cleanly OR before
/// it has sent any magic -- a 1-3 byte tail is a dropped connection, not a
/// protocol error. A truncated BODY after the magic is an error. Callers treat
/// both as "drop this connection".
///
/// There is no request id: responses and events share the one stream, so a
/// client must have exactly ONE request in flight at a time. Correlation ids
/// are a later change; the version header is what this frame carries today.
pub const IPC_MAGIC: [u8; 4] = *b"DAAK";

/// Spec §2.5.3 caps the length prefix to bound allocation; the same 4 MiB
/// default as daak-core's framing. Duplicated as a literal rather than a
/// daak-core dependency so daak-ipc stays a leaf crate.
pub const IPC_MAX_FRAME: u32 = 4 * 1024 * 1024;

pub async fn read_message<R: AsyncRead + Unpin>(r: &mut R) -> Result<Option<IpcMessage>, IpcError> {
    let mut magic = [0u8; 4];
    match r.read_exact(&mut magic).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    if magic != IPC_MAGIC {
        return Err(IpcError::Cbor("bad IPC magic".into()));
    }
    let mut len = [0u8; 4];
    r.read_exact(&mut len).await?;
    let n = u32::from_be_bytes(len) as usize;
    if n > IPC_MAX_FRAME as usize {
        return Err(IpcError::Cbor(format!(
            "frame of {n} bytes exceeds the {IPC_MAX_FRAME} cap"
        )));
    }
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf).await?;
    let frame: IpcFrame =
        ciborium::de::from_reader(buf.as_slice()).map_err(|e| IpcError::Cbor(e.to_string()))?;
    // Read the body BEFORE the version check: a body we cannot parse is a
    // protocol bug, and reporting "update required" for it would send the user
    // off to download a fix that cannot help.
    if frame.v >> 8 != IPC_MAJOR {
        return Err(IpcError::UpdateRequired {
            min_major: IPC_MAJOR,
        });
    }
    Ok(Some(frame.msg))
}

pub async fn write_message<W: AsyncWrite + Unpin>(
    w: &mut W,
    m: &IpcMessage,
) -> Result<(), IpcError> {
    write_frame_raw(
        w,
        &IpcFrame {
            v: IPC_VERSION,
            msg: m.clone(),
        },
    )
    .await
}

/// Write a frame with an EXPLICIT version. `write_message` is the only caller
/// in production; this exists so a test (or a future handshake) can put a
/// version on the wire that `write_message` would never emit.
pub async fn write_frame_raw<W: AsyncWrite + Unpin>(
    w: &mut W,
    frame: &IpcFrame,
) -> Result<(), IpcError> {
    let mut buf = Vec::new();
    ciborium::ser::into_writer(frame, &mut buf).map_err(|e| IpcError::Cbor(e.to_string()))?;
    if buf.len() > IPC_MAX_FRAME as usize {
        return Err(IpcError::Cbor(format!(
            "frame of {} bytes exceeds the {IPC_MAX_FRAME} cap",
            buf.len()
        )));
    }
    w.write_all(&IPC_MAGIC).await?;
    w.write_all(&(buf.len() as u32).to_be_bytes()).await?;
    w.write_all(&buf).await?;
    w.flush().await?;
    Ok(())
}

pub fn socket_path() -> PathBuf {
    // Tests and multi-instance dev override the path explicitly.
    if let Ok(p) = std::env::var("DAAK_SOCK") {
        return PathBuf::from(p);
    }
    #[cfg(unix)]
    {
        let runtime = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
        PathBuf::from(runtime).join("daak").join("daakd.sock")
    }
    #[cfg(windows)]
    {
        PathBuf::from(r"\\.\pipe\daakd")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn request_and_event_roundtrip_over_a_byte_stream() {
        let (mut a, mut b) = tokio::io::duplex(4096);
        let req = IpcMessage::Request(IpcRequest::Subscribe);
        let ev = IpcMessage::Event(IpcEvent::TransferDone {
            transfer_id: "abc".into(),
        });

        let w = tokio::spawn(async move {
            write_message(&mut a, &req).await.unwrap();
            write_message(&mut a, &ev).await.unwrap();
        });
        assert!(matches!(
            read_message(&mut b).await.unwrap().unwrap(),
            IpcMessage::Request(IpcRequest::Subscribe)
        ));
        assert!(matches!(
            read_message(&mut b).await.unwrap().unwrap(),
            IpcMessage::Event(IpcEvent::TransferDone { .. })
        ));
        w.await.unwrap();
    }

    #[tokio::test]
    async fn an_oversized_length_prefix_is_refused_before_allocating() {
        let mut raw = Vec::new();
        raw.extend_from_slice(&IPC_MAGIC);
        raw.extend_from_slice(&(IPC_MAX_FRAME + 1).to_be_bytes());
        let mut c = std::io::Cursor::new(raw);
        assert!(matches!(read_message(&mut c).await, Err(IpcError::Cbor(m)) if m.contains("cap")));
    }

    #[tokio::test]
    async fn a_bad_magic_is_refused() {
        let mut c = std::io::Cursor::new(b"NOPE".to_vec());
        assert!(
            matches!(read_message(&mut c).await, Err(IpcError::Cbor(m)) if m.contains("magic"))
        );
    }

    #[tokio::test]
    async fn a_clean_disconnect_is_none_and_a_truncated_body_is_an_error() {
        let empty = std::io::Cursor::new(Vec::new());
        assert!(read_message(&mut { empty }).await.unwrap().is_none());

        let mut partial = Vec::new();
        partial.extend_from_slice(&IPC_MAGIC);
        partial.extend_from_slice(&8u32.to_be_bytes());
        partial.extend_from_slice(&[1, 2]);
        let mut c = std::io::Cursor::new(partial);
        assert!(read_message(&mut c).await.is_err());
    }

    #[tokio::test]
    async fn a_transfer_item_event_round_trips_with_the_ffi_field_names() {
        let (mut a, mut b) = tokio::io::duplex(4096);
        let ev = IpcMessage::Event(IpcEvent::TransferItem {
            transfer_id: "t1".into(),
            item_index: 2,
            state: "receiving".into(),
            dest_path: "/tmp/a".into(),
        });
        let sent = ev.clone();
        let w = tokio::spawn(async move { write_message(&mut a, &sent).await.unwrap() });
        assert_eq!(read_message(&mut b).await.unwrap().unwrap(), ev);
        w.await.unwrap();
    }
}

#[cfg(test)]
mod version_tests {
    use super::*;

    // daak-ipc has no runtime feature of its own; the tests only drive a
    // Cursor, so a current-thread runtime beats a dev-dependency executor.
    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(f)
    }

    fn frame_bytes(v: u16, msg: &IpcMessage) -> Vec<u8> {
        let mut wire = Vec::new();
        block_on(write_frame_raw(
            &mut wire,
            &IpcFrame {
                v,
                msg: msg.clone(),
            },
        ))
        .unwrap();
        wire
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn the_version_constant_is_major_in_the_high_byte() {
        assert_eq!(IPC_MAJOR, 1);
        assert_eq!(IPC_MINOR, 0);
        assert_eq!(IPC_VERSION, (IPC_MAJOR << 8) | IPC_MINOR);
        assert_eq!(IPC_VERSION, 0x0100);
    }

    #[test]
    fn a_different_major_is_refused_with_the_minimum_we_understand() {
        for major in [2u16, 99] {
            let wire = frame_bytes(major << 8, &IpcMessage::Request(IpcRequest::Subscribe));
            let mut cur = std::io::Cursor::new(wire);
            match block_on(read_message(&mut cur)).unwrap_err() {
                IpcError::UpdateRequired { min_major } => assert_eq!(min_major, IPC_MAJOR),
                other => panic!("expected UpdateRequired for major {major}, got {other:?}"),
            }
        }
    }

    #[test]
    fn a_newer_minor_on_our_major_is_accepted() {
        // Forward compatible WITHIN a major: a 1.9 peer talks to a 1.0 daemon.
        let wire = frame_bytes(
            (IPC_MAJOR << 8) | 9,
            &IpcMessage::Request(IpcRequest::Devices),
        );
        let mut cur = std::io::Cursor::new(wire);
        assert_eq!(
            block_on(read_message(&mut cur)).unwrap(),
            Some(IpcMessage::Request(IpcRequest::Devices))
        );
    }

    #[test]
    fn unknown_fields_in_a_frame_are_ignored() {
        #[derive(serde::Serialize)]
        struct FrameWithExtra<'a> {
            v: u16,
            msg: &'a IpcMessage,
            future_hint: &'a str,
        }

        let original = IpcMessage::Request(IpcRequest::Devices);
        let with_extra = FrameWithExtra {
            v: IPC_VERSION,
            msg: &original,
            future_hint: "later",
        };
        let mut body = Vec::new();
        ciborium::ser::into_writer(&with_extra, &mut body).unwrap();
        let mut wire = Vec::new();
        wire.extend_from_slice(&IPC_MAGIC);
        wire.extend_from_slice(&(body.len() as u32).to_be_bytes());
        wire.extend_from_slice(&body);

        let mut cur = std::io::Cursor::new(wire);
        assert_eq!(block_on(read_message(&mut cur)).unwrap(), Some(original));
    }

    #[test]
    fn update_required_round_trips_as_a_response_the_client_can_read() {
        let msg = IpcMessage::Response(IpcResponse::UpdateRequired {
            min_major: IPC_MAJOR,
        });
        let mut wire = Vec::new();
        block_on(write_message(&mut wire, &msg)).unwrap();
        let mut cur = std::io::Cursor::new(wire);
        assert_eq!(
            block_on(read_message(&mut cur)).unwrap(),
            Some(IpcMessage::Response(IpcResponse::UpdateRequired {
                min_major: IPC_MAJOR
            }))
        );
    }

    // A DIFFERENT minor is still accepted, and these two hex strings are ALSO
    // pinned in packages/core/test/transport.spec.ts. One language alone
    // would let the two drift apart silently; this is the cross-language pin.
    #[test]
    fn the_frame_bytes_match_the_pinned_cross_language_fixtures() {
        let cases: &[(IpcMessage, &str)] = &[
            (
                IpcMessage::Request(IpcRequest::Subscribe),
                "4441414b0000001da26176190100636d7367a1675265717565737469537562736372696265",
            ),
            (
                IpcMessage::Response(IpcResponse::Ok),
                "4441414b00000017a26176190100636d7367a168526573706f6e7365624f6b",
            ),
        ];
        for (msg, want) in cases {
            let mut wire = Vec::new();
            block_on(write_message(&mut wire, msg)).unwrap();
            assert_eq!(&hex(&wire), want, "frame bytes for {msg:?} changed");
        }
    }
}
