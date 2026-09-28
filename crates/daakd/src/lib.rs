//! The desktop daemon's IPC server. It binds the socket, owns ONE real
//! `daak_core::engine::Engine`, answers every request from that engine and fans
//! the engine's events out to subscribed clients.
//!
//! `IpcRequest::Start` is what creates the engine; every other engine-backed
//! request before it answers `Error{"engine not started; send Start first"}`
//! rather than inventing data. Send goes through `Engine::enqueue_outbox_send`,
//! NEVER `send_secure`: a share to a peer that is not on the LAN has to come
//! back as a queued outbox row id, which is the whole reason the outbox exists.

use std::path::Path;
#[cfg(unix)]
use std::sync::Arc;

use daak_core::discovery::PresenceState;
use daak_core::engine::{Engine, EngineConfig, EngineEvent};
use daak_core::manifest::{from_picked_paths, DeviceRef, Manifest, CHUNK_SIZE_DEFAULT};
use daak_core::pairing::PairingBundle;
use daak_core::store::Db;
use daak_ipc::IpcEvent;
#[cfg(unix)]
use daak_ipc::{read_message, write_message};
#[cfg(unix)]
use daak_ipc::{IpcMessage, IpcRequest, IpcResponse};
use tokio::sync::broadcast;
use tokio::sync::RwLock as AsyncRwLock;

pub mod debug_bundle;

const EVENT_BUFFER: usize = 1024;
const NOT_STARTED: &str = "engine not started; send Start first";

/// What `Start` was asked for, kept so a repeated identical Start is a no-op
/// and a CONFLICTING one is refused instead of orphaning the running
/// engine's listener and DB handle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartArgs {
    pub data_dir: String,
    pub display_name: String,
    pub listen_port: u16,
}

struct EngineSlot {
    engine: Arc<Engine>,
    args: StartArgs,
}

/// The daemon's whole mutable state. One engine per process; the RwLock is
/// only ever held long enough to clone the Arc, never across an await on the
/// engine, so a request never blocks another.
pub struct DaemonState {
    slot: AsyncRwLock<Option<EngineSlot>>,
}

impl DaemonState {
    pub fn new() -> Self {
        Self {
            slot: AsyncRwLock::new(None),
        }
    }

    async fn engine(&self) -> Result<Arc<Engine>, IpcResponse> {
        let guard = self.slot.read().await;
        match guard.as_ref() {
            Some(slot) => Ok(slot.engine.clone()),
            None => Err(IpcResponse::Error {
                message: NOT_STARTED.into(),
            }),
        }
    }

    /// The data dir the live engine was started with, which is also where the
    /// daemon owns writable space. `None` before `Start`.
    async fn data_dir(&self) -> Option<String> {
        self.slot
            .read()
            .await
            .as_ref()
            .map(|s| s.args.data_dir.clone())
    }
}

impl Default for DaemonState {
    fn default() -> Self {
        Self::new()
    }
}

/// 16 bytes of hex. Device ids, payload ids (the outbox primary key) and
/// transfer ids are all the same shape, so cancel / retry / filters / send all
/// share one parser. A malformed id is a caller bug and is refused rather than
/// silently degrading into a filter that matches nothing.
fn parse_id(s: &str) -> Result<[u8; 16], IpcResponse> {
    let bytes = hex::decode(s).map_err(|e| IpcResponse::Error {
        message: format!("id must be 32 hex chars: {e}"),
    })?;
    bytes.try_into().map_err(|_| IpcResponse::Error {
        message: format!("id must be 32 hex chars, got {} chars", s.len()),
    })
}

fn err(message: impl std::fmt::Display) -> IpcResponse {
    IpcResponse::Error {
        message: message.to_string(),
    }
}

fn json(value: serde_json::Value) -> IpcResponse {
    match serde_json::to_string(&value) {
        Ok(s) => IpcResponse::Json { value: s },
        Err(e) => err(e),
    }
}

/// One transfers row as the TS `TransferSummary`. Same key set as
/// daak-ffi's transfer_summary_json (R11) and the FFI cannot be a dependency
/// here (it depends on daak-core, so daakd -> daak-ffi would be fine in
/// principle but would drag the uniffi scaffolding into the daemon), so the
/// two shapes are pinned by packages/core's shared contract suite instead.
fn transfer_summary_json(row: &daak_core::store::transfers::TransferRow) -> serde_json::Value {
    serde_json::json!({
        "transferId": hex::encode(row.transfer_id),
        "peerDeviceId": hex::encode(row.peer_device_id),
        "direction": row.direction,
        "kind": row.kind,
        "state": row.state,
        "bytesDone": row.bytes_done,
        "bytesTotal": row.bytes_total,
        "itemCount": row.item_count,
        "updatedAt": row.updated_at,
    })
}

/// One inbox_history row as the TS `InboxEntry`. saved_paths is a JSON string
/// in SQLite and a string[] in TS. A value that will not parse becomes `null`,
/// NOT `[]`: `[]` is a real answer ("this payload saved no files") and a
/// corrupt row must not read as one. Mirrors daak-ffi's inbox_entry_json
/// exactly -- the two must not disagree about what a corrupt row means.
fn inbox_entry_json(row: &daak_core::store::inbox::InboxRow) -> serde_json::Value {
    let saved_paths: serde_json::Value = match serde_json::from_str(&row.saved_paths) {
        Ok(v) => v,
        // No log line: null IS the signal. The daemon does have a
        // subscriber, but logging is not this function's job.
        Err(_) => serde_json::Value::Null,
    };
    serde_json::json!({
        "payloadId": hex::encode(row.id),
        "transferId": hex::encode(row.transfer_id),
        "peerDeviceId": hex::encode(row.peer_device_id),
        "kind": row.kind,
        "itemCount": row.item_count,
        "summary": row.summary,
        "receivedAt": row.received_at,
        "savedPaths": saved_paths,
    })
}

/// Map one engine signal onto the wire. Public (and pure) so the mapping is
/// testable without binding a socket: a NEW EngineEvent variant that has no
/// arm here is a compile error, which is the point.
pub fn to_ipc_event(ev: EngineEvent) -> IpcEvent {
    match ev {
        EngineEvent::DeviceFound(d) => IpcEvent::DeviceFound {
            device_id: hex::encode(d.device_id),
            name: d.name,
            addr: d.addr.to_string(),
        },
        EngineEvent::DeviceLost(id) => IpcEvent::DeviceState {
            device_id: hex::encode(id),
            online: false,
        },
        EngineEvent::Presence { device_id, state } => IpcEvent::DeviceState {
            device_id: hex::encode(device_id),
            online: matches!(state, PresenceState::Online),
        },
        EngineEvent::TransferProgress {
            transfer_id,
            bytes_done,
            bytes_total,
        } => IpcEvent::TransferProgress {
            transfer_id: hex::encode(transfer_id),
            bytes_done,
            bytes_total,
        },
        // The ARM that the exhaustive match demands, and DELIBERATELY identical
        // to the daak-ffi to_ffi_event arm: the same four fields, the same
        // None -> String::new() for a never-materialised item. This is ONE
        // logical event on TWO transports, not a coincidence -- if the two
        // bridges ever disagree, mobile and desktop show different facts about
        // the same received file. IpcEvent::TransferItem already existed
        // (daak-ipc/src/lib.rs:181-186) and is unchanged, so no IpcRequest
        // variant and no new wire field, and no IPC_MINOR bump.
        EngineEvent::TransferItem {
            transfer_id,
            item_index,
            state,
            dest_path,
        } => IpcEvent::TransferItem {
            transfer_id: hex::encode(transfer_id),
            item_index,
            state,
            dest_path: dest_path.unwrap_or_default(),
        },
        EngineEvent::TransferDone { transfer_id } => IpcEvent::TransferDone {
            transfer_id: hex::encode(transfer_id),
        },
        EngineEvent::TransferFailed { transfer_id, error } => IpcEvent::TransferFailed {
            transfer_id: hex::encode(transfer_id),
            error,
        },
        // C1: same missing arm as in daak-ffi. The payload is the daemon's own
        // inbox_entry_json -- identical InboxEntry shape, identical
        // corrupt-saved_paths-means-null contract.
        EngineEvent::InboxReceived(row) => IpcEvent::InboxReceived {
            // Cannot fail, same reasoning as the daak-ffi arm: an InboxEntry
            // is hex strings, a u32, an i64 and array-or-null, and
            // `to_ipc_event` returns IpcEvent with no Result to fail into.
            payload_json: serde_json::to_string(&inbox_entry_json(&row))
                .expect("an InboxEntry is strings, numbers and array-or-null"),
        },
        // C2. Same field name and same hex encoding as the daak-ffi arm, so
        // `case 'PairingDone'` in DaemonClient reads one shape on both bridges.
        EngineEvent::PairingDone { device_id } => IpcEvent::PairingDone {
            device_id: hex::encode(device_id),
        },
    }
}

/// Bind daak_ipc::socket_path() and serve forever.
#[cfg(unix)]
pub async fn serve(path: &Path) -> std::io::Result<()> {
    // The bundle's `recent log` section IS this ring buffer, and it is a
    // global default, so it must be installed before the engine starts
    // logging -- which happens inside serve_with, right after this.
    debug_bundle::init_tracing()
        .map_err(|e| std::io::Error::other(format!("cannot capture daemon logs: {e}")))?;
    // The receiver is dropped on purpose; each subscriber gets its own.
    let (events, _rx) = broadcast::channel::<IpcEvent>(EVENT_BUFFER);
    serve_with(path, events).await
}

/// Same as serve, but the event source is injected. Task 9 bridges the
/// engine's event stream into this sender; the test needs it to publish.
/// Deliberately does NOT install the log ring: the subscriber is process-wide
/// and one test binary starts MANY daakd, so the second try_init would fail.
/// Only the production entry point in serve() pays for it.
#[cfg(unix)]
pub async fn serve_with(path: &Path, events: broadcast::Sender<IpcEvent>) -> std::io::Result<()> {
    let listener = bind(path)?;
    let sender = Arc::new(events);
    let state = Arc::new(DaemonState::new());

    loop {
        let (stream, _) = listener.accept().await?;
        let sender = sender.clone();
        let state = state.clone();
        tokio::spawn(async move {
            // The read and write halves are separate owners, so select! can
            // borrow one in each arm; a single &mut stream would not
            // borrow-check.
            let (mut rd, mut wr) = stream.into_split();
            let mut rx = sender.subscribe();
            let mut subscribed = false;
            // read_message is NOT cancel-safe: it reads into fresh buffers, so
            // dropping it mid-frame throws away every byte it already ate and
            // the next read sees a frame tail as a magic. Keep ONE future
            // alive across select! iterations and replace it only after it has
            // completed, so a losing branch never discards bytes.
            let mut rd_fut = Box::pin(read_message(&mut rd));
            loop {
                tokio::select! {
                    msg = &mut rd_fut => {
                        // A major-version mismatch is answerable: tell the
                        // peer the lowest major we speak, then drop it. Without
                        // this the client only sees a closed socket and cannot
                        // tell an old app from a dead daemon.
                        if let Err(daak_ipc::IpcError::UpdateRequired { min_major }) = &msg {
                            let _ = write_message(
                                &mut wr,
                                &IpcMessage::Response(IpcResponse::UpdateRequired {
                                    min_major: *min_major,
                                }),
                            )
                            .await;
                            break;
                        }
                        // A clean disconnect (Ok(None)) and a truncated body
                        // (Err) both end this connection.
                        let Some(IpcMessage::Request(req)) = msg.ok().flatten() else {
                            break;
                        };
                        let reply = match req {
                            IpcRequest::Subscribe => {
                                subscribed = true;
                                IpcMessage::Response(IpcResponse::Ok)
                            }
                            IpcRequest::Shutdown => {
                                // The engine owns a listener, a DB handle and
                                // four background tasks; a daemon that exits
                                // without stopping them leaves a bound port
                                // and an open SQLite file behind.
                                //
                                // B4: the engine is TAKEN out of the slot, not
                                // just shut down in place. Left in the slot, a
                                // later Start with the same args took the
                                // idempotent branch and answered Port for a
                                // port whose accept task was aborted. Taking
                                // it also drops the last Arc, which is what
                                // actually closes the DB and stops the tasks.
                                if let Some(slot) = state.slot.write().await.take() {
                                    let _ = slot.engine.shutdown().await;
                                }
                                break
                            }
                            // `sender` is the broadcast Sender itself, so a
                            // Start inside it can spawn the engine -> IpcEvent
                            // bridge; the per-connection `rx` is already
                            // subscribed above, so bridge events fan out.
                            other => {
                                IpcMessage::Response(
                                    dispatch(&state, &sender, other).await,
                                )
                            }
                        };
                        // The read is done, so the future is spent: drop it
                        // first (its borrow of rd dies with it) and pin a fresh
                        // read for the next round.
                        drop(rd_fut);
                        rd_fut = Box::pin(read_message(&mut rd));
                        if write_message(&mut wr, &reply).await.is_err() {
                            break;
                        }
                    }
                    ev = rx.recv(), if subscribed => {
                        // ponytail: a lagged subscriber keeps its connection
                        // and silently misses events; Task 9 can drop the
                        // client or send an Error when that matters.
                        if let Ok(ev) = ev {
                            if write_message(&mut wr, &IpcMessage::Event(ev)).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            }
        });
    }
}

/// Answer one request from the live engine. `sender` is the broadcast Sender
/// the engine's event stream is bridged into, so a `Start` here can start the
/// engine AND wire its events without the caller knowing how.
#[cfg(unix)]
async fn dispatch(
    state: &DaemonState,
    sender: &broadcast::Sender<IpcEvent>,
    req: IpcRequest,
) -> IpcResponse {
    match req {
        IpcRequest::Start {
            data_dir,
            display_name,
            listen_port,
        } => start_engine(state, sender, data_dir, display_name, listen_port).await,
        IpcRequest::Devices => match state.engine().await {
            Ok(engine) => {
                let devices = engine.devices().await;
                json(serde_json::Value::Array(
                    devices
                        .iter()
                        .map(|d| {
                            serde_json::json!({
                                "deviceId": hex::encode(d.device_id),
                                "name": d.name,
                                "addr": d.addr.to_string(),
                            })
                        })
                        .collect(),
                ))
            }
            Err(e) => e,
        },
        IpcRequest::Send {
            peer_device_id,
            text,
            files,
        } => send(state, peer_device_id, text, files).await,
        IpcRequest::Cancel { transfer_id } => match state.engine().await {
            Err(e) => e,
            Ok(engine) => match parse_id(&transfer_id).and_then(|id| match engine.cancel(id) {
                Ok(()) => Ok(()),
                Err(e) => Err(err(e)),
            }) {
                Ok(()) => IpcResponse::Ok,
                Err(e) => e,
            },
        },
        IpcRequest::Retry { transfer_id } => match state.engine().await {
            Err(e) => e,
            Ok(engine) => match parse_id(&transfer_id).and_then(|id| match engine.retry(id) {
                Ok(()) => Ok(()),
                Err(e) => Err(err(e)),
            }) {
                Ok(()) => IpcResponse::Ok,
                Err(e) => e,
            },
        },
        IpcRequest::ListTransfers { filter } => {
            let (want_state, want_peer) = match filter {
                None => (None, None),
                Some(f) => {
                    let peer = match &f.peer_device_id {
                        None => None,
                        Some(s) => match parse_id(s) {
                            Ok(id) => Some(id),
                            Err(e) => return e,
                        },
                    };
                    (f.state, peer)
                }
            };
            match state.engine().await {
                Err(e) => e,
                Ok(engine) => match engine.list_transfers(want_state.as_deref(), want_peer) {
                    Ok(rows) => json(serde_json::Value::Array(
                        rows.iter().map(transfer_summary_json).collect(),
                    )),
                    Err(e) => err(e),
                },
            }
        }
        IpcRequest::ListInbox => match state.engine().await {
            Err(e) => e,
            Ok(engine) => match engine.list_inbox() {
                Ok(rows) => json(serde_json::Value::Array(
                    rows.iter().map(inbox_entry_json).collect(),
                )),
                Err(e) => err(e),
            },
        },
        IpcRequest::SetDisplayName { name } => match state.engine().await {
            Err(e) => e,
            Ok(engine) => match engine.set_display_name(name).await {
                Ok(()) => IpcResponse::Ok,
                Err(e) => err(e),
            },
        },
        IpcRequest::SetPresence { state: s } => {
            // Only the states a device declares about ITSELF. 'offline' is
            // what a PEER says about us; nothing withdraws our mDNS record
            // on it, so honouring it here would be a claim the wire cannot
            // back.
            let presence = match s.as_str() {
                "online" => PresenceState::Online,
                "away" => PresenceState::Away,
                other => {
                    return err(format!(
                        "presence state must be 'online' or 'away', got {other:?}"
                    ))
                }
            };
            match state.engine().await {
                Err(e) => e,
                Ok(engine) => match engine.set_presence(presence).await {
                    Ok(()) => IpcResponse::Ok,
                    Err(e) => err(e),
                },
            }
        }
        IpcRequest::Pair { addr, bundle_cbor } => {
            let addr: std::net::SocketAddr = match addr.parse() {
                Ok(a) => a,
                Err(e) => return err(format!("pair addr must be ip:port: {e}")),
            };
            let bundle = match PairingBundle::from_cbor(&bundle_cbor) {
                Ok(b) => b,
                Err(e) => return err(e),
            };
            match state.engine().await {
                Err(e) => e,
                Ok(engine) => match engine.pair_with(addr, bundle).await {
                    Ok((sas, peer)) => json(serde_json::json!({
                        "sas": sas,
                        "peer_device_id": hex::encode(peer),
                    })),
                    Err(e) => err(e),
                },
            }
        }
        IpcRequest::ExportDebugBundle { path } => {
            // A bundle names this device, its listen address and its log, so
            // the destination is daemon-owned. An arbitrary wire path would
            // let any same-user client overwrite the DB, the key store or a
            // service file through a diagnostics request.
            let Some(data_dir) = state.data_dir().await else {
                return IpcResponse::Error {
                    message: NOT_STARTED.into(),
                };
            };
            let name = match debug_bundle::sanitize_bundle_name(&path) {
                Ok(n) => n,
                Err(m) => return err(m),
            };
            let (device_id, listen_addr) = match state.engine().await {
                Ok(engine) => (
                    hex::encode(engine.identity().device_id()),
                    engine.local_addr().to_string(),
                ),
                // Unreachable while data_dir() is Some, but do not answer
                // `Ok` with a bundle missing the section that matters.
                Err(e) => return e,
            };
            let s = debug_bundle::snapshot_state(device_id, listen_addr);
            let out = std::path::Path::new(&data_dir)
                .join("debug-bundles")
                .join(name);
            match debug_bundle::export(&out, &s) {
                Ok(()) => IpcResponse::Ok,
                Err(e) => err(e),
            }
        }
        // Handled by the caller before dispatch ever runs: they close or do
        // not answer. Listed here so a new variant is a compile error rather
        // than a silent Ok.
        IpcRequest::Subscribe | IpcRequest::Shutdown => err(NOT_STARTED),
    }
}

/// Create the socket's parent directory, prove it is ours, and bind 0600.
#[cfg(unix)]
fn bind(path: &Path) -> std::io::Result<tokio::net::UnixListener> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        // socket_path() falls back to /tmp when XDG_RUNTIME_DIR is unset, so
        // another user could pre-create that parent and a socket inside it.
        // Refuse rather than chmod a directory we do not own.
        // SAFETY: geteuid takes no arguments and cannot fail.
        check_owned_by_us(parent, unsafe { libc::geteuid() })?;
        // A stale socket from a crashed daemon is ours to remove. Anything
        // else at this path is a real file or a symlink: unlinking it would
        // delete the user's data, so refuse and leave it alone.
        match std::fs::symlink_metadata(path) {
            Ok(md) => {
                use std::os::unix::fs::FileTypeExt;
                if !md.file_type().is_socket() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::AlreadyExists,
                        format!(
                            "{} exists and is not a socket; refusing to remove it",
                            path.display()
                        ),
                    ));
                }
                std::fs::remove_file(path)?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    let listener = tokio::net::UnixListener::bind(path)?;
    set_mode(path, 0o600)?;
    Ok(listener)
}

/// The `me` parameter exists so this branch is testable without a second uid;
/// production always passes geteuid().
#[cfg(unix)]
fn check_owned_by_us(dir: &Path, me: u32) -> std::io::Result<()> {
    use std::os::unix::fs::MetadataExt;

    let md = std::fs::metadata(dir)?;
    if !md.is_dir() {
        let msg = format!("{} is not a directory", dir.display());
        return Err(std::io::Error::new(std::io::ErrorKind::NotADirectory, msg));
    }
    if md.uid() != me {
        let msg = format!("{} is owned by uid {}, not {me}", dir.display(), md.uid());
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            msg,
        ));
    }
    set_mode(dir, 0o700)
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

// ponytail: Windows needs a named-pipe server on \\.pipe\daakd with a
// current-user ACL, not a Unix socket, so the daemon refuses to start there
// rather than pretending to serve. Task 10's packaging spike owns it.
#[cfg(windows)]
pub async fn serve(path: &Path) -> std::io::Result<()> {
    debug_bundle::init_tracing()
        .map_err(|e| std::io::Error::other(format!("cannot capture daemon logs: {e}")))?;
    let (events, _rx) = broadcast::channel::<IpcEvent>(EVENT_BUFFER);
    serve_with(path, events).await
}

#[cfg(windows)]
pub async fn serve_with(_path: &Path, _events: broadcast::Sender<IpcEvent>) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "named-pipe server not implemented; see Task 10",
    ))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn a_parent_owned_by_another_uid_is_refused_and_not_repaired() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("daak");
        std::fs::create_dir(&sub).unwrap();
        set_mode(&sub, 0o777).unwrap();

        let err = check_owned_by_us(&sub, 1).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
        // Refused means untouched: no quiet chmod of a directory we don't own.
        assert_eq!(
            std::fs::metadata(&sub).unwrap().permissions().mode() & 0o777,
            0o777
        );
    }

    /// SHOULD-FIX 4: a corrupt saved_paths must NOT read as "no saved files".
    /// `[]` is a real answer and `null` says "this row is broken", so the UI
    /// can tell them apart. daak-ffi's identical function is the other half
    /// of this contract; the shared contract suite pins the shape.
    #[test]
    fn a_corrupt_saved_paths_reads_as_null_not_as_an_empty_list() {
        let mut row = daak_core::store::inbox::InboxRow {
            id: [1u8; 16],
            transfer_id: [1u8; 16],
            peer_device_id: [2u8; 16],
            kind: "text".into(),
            item_count: 1,
            summary: "hi".into(),
            received_at: 0,
            saved_paths: "{not json".into(),
        };
        assert!(inbox_entry_json(&row)["savedPaths"].is_null());
        // A real empty list stays an empty list.
        row.saved_paths = "[]".into();
        assert_eq!(inbox_entry_json(&row)["savedPaths"], serde_json::json!([]));
        row.saved_paths = r#"["/tmp/a.bin"]"#.into();
        assert_eq!(
            inbox_entry_json(&row)["savedPaths"],
            serde_json::json!(["/tmp/a.bin"])
        );
    }
}
/// Create (or accept a repeat of) the daemon's single engine, and bridge its
/// event stream into the broadcast channel exactly once.
#[cfg(unix)]
async fn start_engine(
    state: &DaemonState,
    sender: &broadcast::Sender<IpcEvent>,
    data_dir: String,
    display_name: String,
    listen_port: u16,
) -> IpcResponse {
    let args = StartArgs {
        data_dir: data_dir.clone(),
        display_name: display_name.clone(),
        listen_port,
    };
    // A write lock over the whole Start is what makes "exactly one engine"
    // true even if two clients race; the engine is created inside it.
    let mut guard = state.slot.write().await;
    if let Some(slot) = guard.as_ref() {
        if slot.args == args {
            return IpcResponse::Port {
                port: slot.engine.local_addr().port(),
            };
        }
        return err("engine already started with different arguments");
    }
    let dir = std::path::PathBuf::from(&data_dir);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return err(format!("data_dir {data_dir}: {e}"));
    }
    let store = match daak_core::crypto::secret_store::PersistentFileStore::new(dir.join("keys")) {
        Ok(s) => s,
        Err(e) => return err(e),
    };
    let identity = match daak_core::crypto::identity::import_from_store(&store) {
        Ok(i) => i,
        Err(e) => return err(e),
    };
    let db = match Db::open(&dir.join("daak.db")) {
        Ok(d) => d,
        Err(e) => return err(e),
    };
    if let Err(e) = db.migrate() {
        return err(e);
    }
    let listen_addr = match format!("0.0.0.0:{listen_port}").parse() {
        Ok(a) => a,
        Err(e) => return err(e),
    };
    let cfg = EngineConfig {
        display_name,
        listen_addr,
        out_dir: dir.join("downloads"),
        identity,
        db: std::sync::Arc::new(db),
    };
    let engine = match Engine::start(cfg).await {
        Ok(e) => Arc::new(e),
        Err(e) => return err(e),
    };
    let port = engine.local_addr().port();
    bridge_events(engine.events(), sender.clone());
    *guard = Some(EngineSlot { engine, args });
    IpcResponse::Port { port }
}

/// Forward an engine's events into the IPC broadcast. One task per engine;
/// the receiver is created by the CALLER immediately after start, so events
/// published between Engine::start and that call would be lost.
///
/// Takes the RECEIVER, not the engine: a real `Engine` cannot emit a single
/// event without a second peer on the LAN, so taking `&Engine` made the one
/// link between an EngineEvent and a subscribed IPC client impossible to
/// exercise. With the receiver as the input the mapping and the fan-out are
/// both reachable without inventing a fake engine.
#[cfg(unix)]
pub fn bridge_events(
    mut rx: broadcast::Receiver<EngineEvent>,
    sender: broadcast::Sender<IpcEvent>,
) {
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    // No subscribers yet is normal (the client subscribes
                    // after Start), and a send error only means that.
                    let _ = sender.send(to_ipc_event(ev));
                }
                // A lagged receiver means this daemon's own mapping task
                // could not keep up. Re-subscribing drops the backlog, which
                // is the honest outcome: a UI resyncs from ListTransfers.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    });
}

/// `IpcRequest::Send`, through the OUTBOX. This is the phase's central
/// obligation: `send_secure` would fail for a peer that is not on the LAN, and
/// a share surface that cannot queue is not the offline sharing Phase 3 built.
#[cfg(unix)]
async fn send(
    state: &DaemonState,
    peer_device_id: String,
    text: Option<String>,
    files: Vec<String>,
) -> IpcResponse {
    let peer = match parse_id(&peer_device_id) {
        Ok(p) => p,
        Err(e) => return e,
    };
    let has_text = text.as_ref().is_some_and(|t| !t.is_empty());
    let has_files = !files.is_empty();
    if has_text && has_files {
        return err("send takes text or files, not both");
    }
    if !has_text && !has_files {
        return err("refusing an empty send");
    }
    let engine = match state.engine().await {
        Ok(e) => e,
        Err(e) => return e,
    };
    let sender_ref = DeviceRef {
        device_id: engine.identity().device_id(),
        name: engine.display_name().await,
    };
    let (manifest, paths) = if let Some(t) = text {
        let mut m = Manifest::text(&t);
        m.sender = sender_ref;
        (m, Vec::new())
    } else {
        // B1: a picked path can be a DIRECTORY, which Item::from_file rejects
        // outright. from_picked_paths expands a folder into one item per file
        // so a folder share has bytes to send at all.
        let picked: Vec<std::path::PathBuf> =
            files.into_iter().map(std::path::PathBuf::from).collect();
        match from_picked_paths(sender_ref, &picked, CHUNK_SIZE_DEFAULT) {
            Ok(pair) => pair,
            Err(e) => return err(e),
        }
    };
    match engine.enqueue_outbox_send(peer, manifest, paths).await {
        Ok(payload_id) => json(serde_json::json!({
            "transferId": hex::encode(payload_id),
            // What the outbox actually knows: the row is durable. It is NOT a
            // delivery receipt; delivery shows up in transfers.state.
            "queued": true,
        })),
        Err(e) => err(e),
    }
}
