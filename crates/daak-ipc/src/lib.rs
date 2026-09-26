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
    TransferDone {
        transfer_id: String,
    },
    TransferFailed {
        transfer_id: String,
        error: String,
    },
    InboxReceived {
        payload: String,
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
pub const IPC_MAGIC: [u8; 4] = *b"DAAK";

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
    // ponytail: the length prefix is UNBOUNDED, so a hostile local client can
    // make the daemon allocate up to 4 GiB. The socket is a UDS/pipe only the
    // same user can open; cap it alongside the schema version in T8.
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
}
