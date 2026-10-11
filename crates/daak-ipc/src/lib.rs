use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// CBOR byte string for a `Vec<u8>` field. `serde` would otherwise encode it
/// as a CBOR ARRAY, which is not what `bstr` means in proto/ipc.cddl. This is
/// the same trick `daak-core`'s `manifest::byte_array` uses, duplicated because
/// that module is `pub(crate)` and daak-ipc is a leaf crate with no
/// daak-core dependency. The `visit_seq` arm is BACKWARD tolerance for an
/// array-encoded peer (an older or buggy encoder), not forward compatibility;
/// it is kept so a peer mid-upgrade does not hard-fail on a pairing bundle.
mod bstr_bytes {
    use serde::de::{Error, Visitor};
    use serde::{Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bytes(bytes)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        struct BytesVisitor;

        impl<'de> Visitor<'de> for BytesVisitor {
            type Value = Vec<u8>;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a CBOR byte string")
            }

            fn visit_bytes<E: Error>(self, v: &[u8]) -> Result<Self::Value, E> {
                Ok(v.to_vec())
            }

            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut a: A,
            ) -> Result<Self::Value, A::Error> {
                let mut out = Vec::with_capacity(a.size_hint().unwrap_or(0));
                while let Some(b) = a.next_element::<u8>()? {
                    out.push(b);
                }
                Ok(out)
            }
        }
        deserializer.deserialize_bytes(BytesVisitor)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum IpcMessage {
    Request(IpcRequest),
    Response(IpcResponse),
    Event(IpcEvent),
}

/// The optional narrowing `IpcRequest::ListTransfers` carries. Both fields are
/// Option and both default to absent, so `{}` and a missing filter mean the
/// same thing (list everything) and the daemon can never confuse "no filter"
/// with "filter on the empty string".
///
/// `state` is a String, not an enum, on purpose: the valid values are the
/// transfers.state vocabulary in spec 4.2 (queued|active|paused|awaiting_ack|
/// done|failed|canceled), which daak-core owns and which adding a variant to
/// here would silently make the daemon accept a state no row can have. An
/// unknown state filters to zero rows, which is the honest answer.
///
/// `deny_unknown_fields` is load-bearing. The alternative is a key that is
/// silently DROPPED, which turns `listTransfers({peerDeviceId})` into a
/// whole-table list (B1) -- a wrong ANSWER, which is worse than a loud one.
///
/// The cost, stated honestly: an unknown field on OUR OWN major is a plain
/// `IpcError::Cbor` and daakd drops the connection on it, so a future 1.x
/// client that adds a filter key cannot talk to a 1.0 daemon at all. That is
/// a deliberate narrowing: the additive space for a MINOR bump is a new
/// IpcRequest variant, not a new field inside an existing struct. A filter
/// key added later needs a major bump of its own.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransferFilter {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peer_device_id: Option<String>,
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
        // A raw byte string, NOT a CBOR array: proto/ipc.cddl says bstr and a
        // pairing bundle is bytes. serde's Vec<u8> would emit 83 01 02 03.
        #[serde(with = "bstr_bytes")]
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
    /// Re-arm ONE item of a transfer, rather than the whole transfer. This is
    /// a DISTINCT variant and not a field on Retry because the two are
    /// different operations. It carries an item_index, which Retry has no
    /// meaning for. PARKED: nothing calls it, because an inbound transfer has
    /// no outbox row to re-pend and the push-only wire protocol has no message a
    /// receiver can send to ask for a file again.
    RetryItem {
        transfer_id: String,
        item_index: u32,
    },
    /// Read back one held-back (quarantined) item: the two fingerprints and
    /// what this device really recorded about it. A DISTINCT variant from
    /// RetryItem because it is a READ -- it mutates nothing, so opening the
    /// screen cannot change what is held.
    QuarantineReport {
        transfer_id: String,
        item_index: u32,
    },
    /// Every held-back item on this device. The DISCOVERY half of
    /// QuarantineReport: without it the screen would need a transfer id and an
    /// item index the user has never seen, and the only way to get those is to
    /// guess indexes -- which also means hashing every item of every transfer.
    /// A unit variant, like ListInbox, because there is nothing to ask for.
    ListQuarantineReports,
    /// Discard a held-back item for good. Its OWN request rather than a flag on
    /// QuarantineReport: reading a file and deleting it are different decisions
    /// and a caller must name the one it means.
    DeleteQuarantined {
        transfer_id: String,
        item_index: u32,
    },
    /// `filter` is Option because the UI's first call has none: an absent
    /// filter lists EVERY transfer, which is a different SQL from any filter
    /// combination, so a Default here would silently mean "state = ''".
    ListTransfers {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        filter: Option<TransferFilter>,
    },
    /// One page of the thread of a peer: sent and received items together.
    /// A DISTINCT request from ListTransfers because it returns items, not
    /// transfers. Before holds the opaque olderCursor of the previous page.
    ListThread {
        peer_device_id: String,
        limit: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        before: Option<String>,
    },
    /// The whole text of one text item. A thread page cuts a long text, so a
    /// copy of the page text can lose data. A DISTINCT request because the
    /// answer is one string, not a page.
    GetItemText {
        transfer_id: String,
        item_index: u32,
    },
    ListInbox,
    /// This device's OWN advertised name and device id. The read half of
    /// SetDisplayName: without it a UI can rename and never show what the LAN
    /// actually resolved the name to.
    SelfProfile,
    SetDisplayName {
        name: String,
    },
    SetPresence {
        state: String,
    },
    /// Write a plain-text debug bundle (version, identity, recent log) on the
    /// DAEMON's machine. `path` is a FILE NAME, not a location: the daemon
    /// owns the directory (a bundle holds the device id and log lines, so it
    /// is not a client-chosen destination) and refuses anything that is not a
    /// single component. Where it actually landed is NOT in this response --
    /// the daemon picks the directory -- so the UI surfaces the daemon's data
    /// dir to the user rather than being handed a path it cannot know.
    ExportDebugBundle {
        path: String,
    },
    /// The platform asks the daemon to drain its outbox now: the desktop app
    /// sends this on a network change or on resume. A new IpcRequest variant is
    /// the minor version extension mechanism.
    Wake,
    /// Revoke one peer's local trust. The daemon purges that peer's queued
    /// outbox rows, cleans its staging, drops its live session, and refuses its
    /// later handshakes. The peer is named by 32 lowercase hex chars.
    Revoke {
        peer_device_id: String,
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
    /// C2. A pairing row was persisted, so the peer list the UI renders is
    /// stale until this arrives. Same field name and same hex id as the FFI
    /// arm, so both bridges deliver one shape to TS.
    PairingDone {
        device_id: String,
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
    /// A peer this build refuses for a version reason, with BOTH real version
    /// numbers. Same fields, same names and the same meaning as the FFI arm
    /// (crates/daak-ffi/src/lib.rs IncompatiblePeerEvent): the UI must read one
    /// shape whichever bridge delivered it, so a desktop and a phone on the
    /// same LAN cannot disagree about whether an update is needed.
    ///
    /// THIS VARIANT ALONE owes no IPC_MINOR bump, and the exemption does not
    /// extend to IpcRequest. It is a new EVENT variant on the externally
    /// tagged enum: an older client's `toDaakEvent` gets an unknown name,
    /// returns undefined and drops the event, whereas the frame itself still
    /// decoded fine.
    ///
    /// A new IpcRequest variant is the OPPOSITE case and DOES owe a bump, even
    /// though IpcRequest also lacks deny_unknown_fields: on the server side the
    /// body decode is what fails, and daakd handles a read error with a
    /// `tracing::warn!` and a bare `break` (crates/daakd/src/lib.rs), so the
    /// connection is dropped SILENTLY. A newer minor on the same major is the
    /// only thing that makes that observable instead of invisible.
    IncompatiblePeer {
        peer_device_id: String,
        peer_name: String,
        peer_version: u16,
        our_version: u16,
    },
    /// The number of unsent outbox rows for a peer. Same fields and same
    /// meaning as the FFI arm, so both bridges hand the UI one shape.
    QueueDepth {
        device_id: String,
        queued: u64,
    },
    /// A trusted peer declared a new presence state ("online" or "away") in its
    /// sealed beacon. Same fields and meaning as the FFI arm. A new EVENT
    /// variant owes no IPC_MINOR bump (see IncompatiblePeer above).
    DevicePresence {
        device_id: String,
        presence: String,
    },
}

/// The whole frame: a schema version plus the message. The ABSENCE of
/// `deny_unknown_fields` is load-bearing -- it is what lets a frame from a
/// newer 1.x peer (one that added a key) decode instead of erroring.
/// `#[serde(default)]` on `v` is NOT forward compatibility: a frame with no
/// version at all becomes 0 and is then refused by the major check, which is
/// the intended behaviour and matches proto/ipc.cddl, where "v" is mandatory.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IpcFrame {
    #[serde(default)]
    pub v: u16,
    pub msg: IpcMessage,
}

/// Just the frame's version header. `read_message` deserializes this FIRST so a
/// foreign major is reported as `UpdateRequired` before the body is decoded at
/// all -- a major bump is usually accompanied by renamed variants, and those
/// would otherwise be a hard serde error the version check never sees. It
/// carries no `msg`, and the ABSENCE of `deny_unknown_fields` is what lets it
/// read the version out of a frame whose body this build cannot name.
#[derive(Debug, Deserialize)]
struct FrameVersion {
    #[serde(default)]
    v: u16,
}

/// The IPC schema version this build speaks. HIGH byte = major, low byte =
/// minor, so 1.0 is 0x0100 = 256. A peer is compatible when
/// `(v >> 8) == IPC_MAJOR`: a newer MINOR is accepted (additive fields live
/// there), a different MAJOR is refused.
pub const IPC_MAJOR: u16 = 1;
pub const IPC_MINOR: u16 = 6;
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
    // Read the VERSION before the body. The rule is:
    //   body we cannot NAME  (unknown variant) -> UpdateRequired; we have no
    //     idea what it means, and a peer that renamed its variants is exactly
    //     what a major bump is for. Reporting a CBOR error here shows the user
    //     a dropped socket instead of an update prompt.
    //   body that is genuinely MALFORMED on an accepted major -> Cbor error;
    //     telling that user to update would send them for a fix that cannot
    //     help.
    // Reading the body first conflated the two and made UpdateRequired
    // unreachable for a realistic bump.
    let version: FrameVersion =
        ciborium::de::from_reader(buf.as_slice()).map_err(|e| IpcError::Cbor(e.to_string()))?;
    if version.v >> 8 != IPC_MAJOR {
        return Err(IpcError::UpdateRequired {
            min_major: IPC_MAJOR,
        });
    }
    let frame: IpcFrame =
        ciborium::de::from_reader(buf.as_slice()).map_err(|e| IpcError::Cbor(e.to_string()))?;
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
        assert_eq!(IPC_MINOR, 6);
        assert_eq!(IPC_VERSION, (IPC_MAJOR << 8) | IPC_MINOR);
        assert_eq!(IPC_VERSION, 0x0106);
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
    fn a_foreign_major_with_a_body_we_cannot_name_is_still_update_required() {
        // The case the version header exists for: a peer on another major
        // ALSO renamed or added variants, so our body enum cannot decode it.
        // Decoding the body first turned this into a CBOR error and the peer
        // only ever saw a closed socket.
        #[derive(serde::Serialize)]
        struct FutureFrame<'a> {
            v: u16,
            msg: &'a str,
        }
        let body = FutureFrame {
            v: 2 << 8,
            msg: "SubscribeV2",
        };
        let mut inner = Vec::new();
        ciborium::ser::into_writer(&body, &mut inner).unwrap();
        let mut wire = Vec::new();
        wire.extend_from_slice(&IPC_MAGIC);
        wire.extend_from_slice(&(inner.len() as u32).to_be_bytes());
        wire.extend_from_slice(&inner);

        let mut cur = std::io::Cursor::new(wire);
        match block_on(read_message(&mut cur)).unwrap_err() {
            IpcError::UpdateRequired { min_major } => assert_eq!(min_major, IPC_MAJOR),
            other => panic!("expected UpdateRequired, got {other:?}"),
        }
    }

    #[test]
    fn a_malformed_body_on_our_own_major_is_still_a_cbor_error() {
        // Pins the other side of the version rule: a body we cannot decode on
        // an ACCEPTED major is a Cbor error, never UpdateRequired. Moving the
        // version check back after the body decode would break exactly this
        // and leave every other test green.
        #[derive(serde::Serialize)]
        struct FutureFrame<'a> {
            v: u16,
            msg: &'a str,
        }
        let body = FutureFrame {
            v: IPC_VERSION,
            msg: "SubscribeV2",
        };
        let mut inner = Vec::new();
        ciborium::ser::into_writer(&body, &mut inner).unwrap();
        let mut wire = Vec::new();
        wire.extend_from_slice(&IPC_MAGIC);
        wire.extend_from_slice(&(inner.len() as u32).to_be_bytes());
        wire.extend_from_slice(&inner);

        let mut cur = std::io::Cursor::new(wire);
        match block_on(read_message(&mut cur)).unwrap_err() {
            IpcError::Cbor(_) => {}
            other => panic!("expected Cbor on our own major, got {other:?}"),
        }
    }

    #[test]
    fn a_frame_with_no_version_at_all_is_refused() {
        // `v` is mandatory in proto/ipc.cddl. A frame without one is either a
        // pre-version peer or a truncated header, and either way it is not a
        // frame we can trust, so it must not decode as a normal message.
        #[derive(serde::Serialize)]
        struct Unversioned<'a> {
            msg: &'a IpcMessage,
        }
        let body = Unversioned {
            msg: &IpcMessage::Request(IpcRequest::Subscribe),
        };
        let mut inner = Vec::new();
        ciborium::ser::into_writer(&body, &mut inner).unwrap();
        let mut wire = Vec::new();
        wire.extend_from_slice(&IPC_MAGIC);
        wire.extend_from_slice(&(inner.len() as u32).to_be_bytes());
        wire.extend_from_slice(&inner);

        let mut cur = std::io::Cursor::new(wire);
        assert!(matches!(
            block_on(read_message(&mut cur)),
            Err(IpcError::UpdateRequired { .. })
        ));
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
                "4441414b0000001da26176190106636d7367a1675265717565737469537562736372696265",
            ),
            (
                IpcMessage::Response(IpcResponse::Ok),
                "4441414b00000017a26176190106636d7367a168526573706f6e7365624f6b",
            ),
        ];
        for (msg, want) in cases {
            let mut wire = Vec::new();
            block_on(write_message(&mut wire, msg)).unwrap();
            assert_eq!(&hex(&wire), want, "frame bytes for {msg:?} changed");
        }
    }

    // Pair's bundle_cbor is the one place this wire carries raw bytes, and
    // proto/ipc.cddl says bstr while a bare Vec<u8> would serialise as a CBOR
    // ARRAY. The CDDL validator cannot prove the difference (it stops
    // discriminating fields once a rule is a multi-arm choice), so the bytes
    // are pinned here and in packages/core/test/transport.spec.ts instead.
    #[test]
    fn pair_carries_its_bundle_as_a_cbor_byte_string() {
        let msg = IpcMessage::Request(IpcRequest::Pair {
            addr: "10.0.0.2:9000".into(),
            bundle_cbor: vec![1, 2, 3],
        });
        let mut body = Vec::new();
        ciborium::ser::into_writer(
            &IpcFrame {
                v: IPC_VERSION,
                msg: msg.clone(),
            },
            &mut body,
        )
        .unwrap();
        assert!(
            body.windows(2).any(|w| w == [0x43, 0x01]),
            "bundle_cbor must be a 3-byte bstr (43 01 02 03), got {}",
            hex(&body)
        );

        let mut wire = Vec::new();
        block_on(write_message(&mut wire, &msg)).unwrap();
        assert_eq!(
            hex(&wire),
            "4441414b0000003da26176190106636d7367a16752657175657374a16450616972a264616464726d31302e302e302e323a393030306b62756e646c655f63626f7243010203",
            "pair frame bytes changed"
        );
        let mut cur = std::io::Cursor::new(wire);
        assert_eq!(block_on(read_message(&mut cur)).unwrap(), Some(msg));
    }
}
