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
    Error { message: String },
    Json { value: String },
    Port { port: u16 },
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

#[derive(Debug, thiserror::Error)]
pub enum IpcError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("cbor: {0}")]
    Cbor(String),
}

/// Local IPC magic (spec §6.3). Every message is `DAAK` + u32 length + CBOR.
///
/// `read_message` returns Ok(None) when the peer disconnects cleanly OR before
/// it has sent any magic -- a 1-3 byte tail is a dropped connection, not a
/// protocol error. A truncated BODY after the magic is an error. Callers treat
/// both as "drop this connection".
///
/// There is no request id: responses and events share the one stream, so a
/// client must have exactly ONE request in flight at a time. Task 8 re-derives
/// this framing from proto/ipc.cddl and may add correlation.
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
    let msg =
        ciborium::de::from_reader(buf.as_slice()).map_err(|e| IpcError::Cbor(e.to_string()))?;
    Ok(Some(msg))
}

pub async fn write_message<W: AsyncWrite + Unpin>(
    w: &mut W,
    m: &IpcMessage,
) -> Result<(), IpcError> {
    let mut buf = Vec::new();
    ciborium::ser::into_writer(m, &mut buf).map_err(|e| IpcError::Cbor(e.to_string()))?;
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
