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
use std::sync::Arc;

use daak_core::crypto::secret_store::SecretStore;
use daak_core::discovery::PresenceState;
use daak_core::engine::{Engine, EngineConfig, EngineEvent};
use daak_core::manifest::{from_picked_paths, DeviceRef, Manifest, CHUNK_SIZE_DEFAULT};
use daak_core::pairing::PairingBundle;
use daak_core::store::Db;
use daak_ipc::IpcEvent;
#[cfg(unix)]
use daak_ipc::{read_message, write_message, IPC_MAJOR};
#[cfg(unix)]
use daak_ipc::{IpcMessage, IpcRequest, IpcResponse};
#[cfg(unix)]
use tokio::io::{AsyncRead, AsyncWrite};
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
    /// Where `Start` gets the identity from, when the caller supplied one.
    /// `None` -- every pre-Task-13 caller, including all the tests -- keeps
    /// today's behaviour exactly: a 0600 file per key under the CLIENT's
    /// `data_dir`. `Some` is the OS keystore, injected by `serve_with_store`.
    /// Read only inside `start_engine`, which already holds the write lock, so
    /// no extra synchronisation is needed.
    key_store: Option<Arc<dyn SecretStore>>,
}

impl DaemonState {
    pub fn new() -> Self {
        Self {
            slot: AsyncRwLock::new(None),
            key_store: None,
        }
    }

    /// The daemon's identity comes from `key_store` instead of from
    /// `<data_dir>/keys`.
    #[cfg(unix)]
    pub fn with_key_store(key_store: Arc<dyn SecretStore>) -> Self {
        Self {
            slot: AsyncRwLock::new(None),
            key_store: Some(key_store),
        }
    }

    async fn engine(&self) -> Result<Arc<Engine>, IpcResponse> {
        let guard = self.slot.read().await;
        match guard.as_ref() {
            Some(slot) => Ok(slot.engine.clone()),
            // B6: routed through err() so the single most common daemon error
            // -- a request that arrived before Start -- is in the bundle. It
            // is hand-built here only because it lives before err().
            None => Err(err(NOT_STARTED)),
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
    let bytes = hex::decode(s).map_err(|e| err(format!("id must be 32 hex chars: {e}")))?;
    bytes
        .try_into()
        .map_err(|_| err(format!("id must be 32 hex chars, got {} chars", s.len())))
}

/// B6: the most chars of any one peer-supplied error string.
///
/// This is a BACKSTOP, not a fix for a measured leak. `err()` is handed
/// arbitrary strings built from peer input, and the IPC frame cap is 4 MiB, so
/// a future call site that interpolates a peer string could otherwise put
/// megabytes into each of 512 ring slots -- enough to evict everything the ring
/// exists to capture. Today the known peer-influenced errors are all small and
/// free of peer content: `read_message` yields "bad IPC magic", a
/// "frame of N bytes exceeds the ... cap" naming only digits, or an `io:`
/// wrapper around a `std::io::Error`, and a ciborium decode error reports the
/// expected TYPE rather than echoing the offending value.
///
/// The head is kept because that is the part that names the failure. The bound
/// is pinned by `err_bounds_whatever_it_is_handed`.
const LOG_MAX_CHARS: usize = 512;

fn log_line(msg: impl std::fmt::Display) -> String {
    let s = msg.to_string();
    if s.chars().count() <= LOG_MAX_CHARS {
        return s;
    }
    s.chars().take(LOG_MAX_CHARS).collect::<String>() + "...[truncated]"
}

fn err(message: impl std::fmt::Display) -> IpcResponse {
    // B6: the client is told the error and the process forgot it, so a debug
    // bundle exported for exactly this failure had an empty `recent log`. This
    // is the one line every IPC failure funnels through.
    tracing::warn!("ipc error: {}", log_line(&message));
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

/// One held-back item as the TS `QuarantineReport`. Mirrors daak-ffi's
/// quarantine_report_json for the same reason as transfer_summary_json above.
///
/// The two fingerprints are hex STRINGS because the screen renders them in
/// groups for a person to compare by eye. Every optional is an explicit `null`
/// rather than an omitted key: an absent field would be indistinguishable from
/// a bridge that forgot it, and `null` is the honest "this device never
/// recorded that".
fn quarantine_report_json(report: &daak_core::engine::QuarantineReport) -> serde_json::Value {
    serde_json::json!({
        "transferId": hex::encode(report.transfer_id),
        "itemIndex": report.item_index,
        "name": report.name,
        "size": report.size,
        "senderName": report.sender_name,
        // The REAL device id, so a screen can say "Device aabbccdd" when no
        // paired label was ever recorded. An identifier, not an invented name
        // -- which is exactly why it may stand in for one.
        "senderDeviceId": report.sender_device_id.map(hex::encode),
        "receivedAt": report.received_at,
        "expected": hex::encode(report.expected),
        "actual": hex::encode(report.actual),
        "heldPath": report.held_path,
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
        // The sealed-beacon liveness transition. Same IpcEvent::DeviceState
        // shape as the Presence arm above: the desktop UI reads online/offline
        // only, and the beacon IS the online source.
        EngineEvent::DeviceState { device_id, online } => IpcEvent::DeviceState {
            device_id: hex::encode(device_id),
            online,
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
        // (daak-ipc/src/lib.rs:181-186) and is unchanged, so this arm added no
        // IpcRequest variant and no new wire field. An IPC_MINOR bump is owed
        // when a new IpcRequest variant IS added -- a new request key is the
        // additive extension, since TransferFilter's deny_unknown_fields
        // forbids a new key on an existing wire struct -- and none is owed
        // here for exactly that reason.
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
        // Same four fields as the daak-ffi arm, byte for byte, so both bridges
        // hand the UI one shape. Both versions are real: the peer's mDNS TXT
        // `v` and this build's MANIFEST_VERSION.
        EngineEvent::IncompatiblePeer {
            peer_device_id,
            peer_name,
            peer_version,
            our_version,
        } => IpcEvent::IncompatiblePeer {
            peer_device_id: hex::encode(peer_device_id),
            peer_name,
            peer_version,
            our_version,
        },
    }
}

/// Bind daak_ipc::socket_path() and serve forever.
#[cfg(unix)]
pub async fn serve(path: &Path) -> std::io::Result<()> {
    // The bundle's `recent log` section IS this ring buffer, and it is a
    // global default, so it must be installed before the engine starts
    // logging -- which happens inside the accept loop, right after this.
    debug_bundle::init_tracing()
        .map_err(|e| std::io::Error::other(format!("cannot capture daemon logs: {e}")))?;
    // DELIBERATE: serve() stays on the 0600 FILE store under the client's
    // data_dir. It does NOT call platform_store(None), because doing so would
    // silently re-home every existing desktop identity: an install created
    // before Task 13 has its keys on disk, an empty OS keystore reads as
    // (None, None), and import_from_store would MINT A BRAND-NEW IDENTITY --
    // every stored pairing row would point at the old device id and the device
    // would re-pair as new with nothing on screen saying why. That is the exact
    // R40(a) failure this file already warns about three times.
    //
    // Migrating the existing keys into the keystore is deliberately NOT done
    // here: a silent migration is more code, more risk, and a different task.
    // The SHIPPED daemon is unaffected either way -- main.rs calls
    // serve_with_store directly -- so this choice only stops serve() from
    // being a trap for the next caller.
    // The receiver is dropped on purpose; each subscriber gets its own.
    let (events, _rx) = broadcast::channel::<IpcEvent>(EVENT_BUFFER);
    accept_loop(path, Arc::new(events), Arc::new(DaemonState::new())).await
}

/// Same as `serve`, but the identity comes from `store` -- the OS keystore,
/// optionally behind the Argon2id passphrase gate.
///
/// There is deliberately no `serve_with` counterpart that takes a store: the
/// two existing entry points (`serve`, and `serve_with` for an injected event
/// sender) are the ones every test and the JS-side daemon contract suite calls,
/// so they keep their exact signatures. `serve_with_store` is the store-aware
/// one; a test that needs both simply composes the two parts below.
#[cfg(unix)]
pub async fn serve_with_store(path: &Path, store: Arc<dyn SecretStore>) -> std::io::Result<()> {
    // The receiver is dropped on purpose; each subscriber gets its own.
    let (events, _rx) = broadcast::channel::<IpcEvent>(EVENT_BUFFER);
    accept_loop(
        path,
        Arc::new(events),
        Arc::new(DaemonState::with_key_store(store)),
    )
    .await
}

/// Same as serve, but the event source is injected. Task 9 bridges the
/// engine's event stream into this sender; the test needs it to publish.
/// Deliberately does NOT install the log ring: the subscriber is process-wide
/// and one test binary starts MANY daakd, so the second try_init would fail.
/// Only the production entry point in serve() pays for it.
#[cfg(unix)]
pub async fn serve_with(path: &Path, events: broadcast::Sender<IpcEvent>) -> std::io::Result<()> {
    accept_loop(path, Arc::new(events), Arc::new(DaemonState::new())).await
}

/// The accept loop itself, with the state and the event sender both injected.
/// Split out of `serve_with` so `serve_with_store` can install the OS store
/// without a second copy of the loop.
#[cfg(unix)]
async fn accept_loop(
    path: &Path,
    events: Arc<broadcast::Sender<IpcEvent>>,
    state: Arc<DaemonState>,
) -> std::io::Result<()> {
    let listener = bind(path)?;

    loop {
        let (stream, _) = listener.accept().await?;
        let sender = events.clone();
        let state = state.clone();
        // The read and write halves are separate owners, so select! can
        // borrow one in each arm; a single &mut stream would not borrow-check.
        let (rd, wr) = stream.into_split();
        tokio::spawn(serve_connection(state, sender, rd, wr));
    }
}

/// The per-connection handler, split out of the accept loop so it can be
/// driven over an in-memory duplex. The two paths that were silent on the
/// accept loop -- a write that fails because the client is gone, and a read
/// that ends -- are NOT REACHABLE from an accepted-socket test: the reply to
/// every request a client can send before `Start` is ~50 bytes, and the
/// kernel buffer accepts that with no reader at all, so the daemon lands on
/// its READ arm and never on the write failure. The read half is generic for
/// the same reason -- nothing about these paths needs a real socket, and a
/// test that needs one has to be run escalated.
#[cfg(unix)]
async fn serve_connection<R, W>(
    state: Arc<DaemonState>,
    sender: Arc<broadcast::Sender<IpcEvent>>,
    mut rd: R,
    mut wr: W,
) where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
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
                    // B6: an old app is a real support case and the
                    // client only ever saw a closed socket, so the
                    // reason it was closed has to be in the bundle --
                    // whether or not the answer below lands.
                    tracing::warn!("ipc version mismatch: peer needs major {min_major}, this build speaks major {IPC_MAJOR}");
                    let refused = write_message(
                        &mut wr,
                        &IpcMessage::Response(IpcResponse::UpdateRequired {
                            min_major: *min_major,
                        }),
                    )
                    .await;
                    if let Err(e) = refused {
                        tracing::warn!("ipc version-mismatch reply write failed: {e}");
                    }
                    break;
                }
                // A clean disconnect (Ok(None)) and a truncated body
                // (Err) both end this connection.
                let req = match msg {
                    // A well-formed frame carrying an Event or a
                    // Response, i.e. the client is speaking the
                    // server's half of the protocol.
                    Ok(Some(IpcMessage::Response(_))) | Ok(Some(IpcMessage::Event(_))) => {
                        tracing::warn!("ipc client sent a non-request frame");
                        break;
                    }
                    Ok(Some(IpcMessage::Request(req))) => req,
                    // Ok(None) is the ordinary case: the app quit.
                    // One line per connection, and a desktop app
                    // reconnects on every foreground, so this is a
                    // handful of lines per session, not a flood.
                    Ok(None) => {
                        tracing::warn!("ipc client disconnected");
                        break;
                    }
                    // A peer that sent a magic and then a truncated or
                    // malformed body is NOT a normal close, and this
                    // used to be a bare `break` with nothing recorded
                    // anywhere. `e` is peer-controlled, so it goes
                    // through the same cap as err().
                    Err(e) => {
                        tracing::warn!(
                            "ipc connection ended on an unreadable frame: {}",
                            log_line(e)
                        );
                        break;
                    }
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
                if let Err(e) = write_message(&mut wr, &reply).await {
                    tracing::warn!("ipc reply write failed: {e}");
                    break;
                }
            }
            ev = rx.recv(), if subscribed => {
                // ponytail: a lagged subscriber keeps its connection
                // and silently misses events; Task 9 can drop the
                // client or send an Error when that matters.
                if let Ok(ev) = ev {
                    if let Err(e) = write_message(&mut wr, &IpcMessage::Event(ev)).await {
                        tracing::warn!("ipc event write failed: {e}");
                        break;
                    }
                }
            }
        }
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
        IpcRequest::RetryItem {
            transfer_id,
            item_index,
        } => match state.engine().await {
            Err(e) => e,
            Ok(engine) => match parse_id(&transfer_id).and_then(|id| {
                match engine.retry_item(id, item_index) {
                    Ok(()) => Ok(()),
                    Err(e) => Err(err(e)),
                }
            }) {
                Ok(()) => IpcResponse::Ok,
                Err(e) => e,
            },
        },
        IpcRequest::QuarantineReport {
            transfer_id,
            item_index,
        } => match state.engine().await {
            Err(e) => e,
            Ok(engine) => match parse_id(&transfer_id) {
                Err(e) => e,
                Ok(id) => match engine.quarantine_report(id, item_index) {
                    Ok(report) => json(quarantine_report_json(&report)),
                    Err(e) => err(e),
                },
            },
        },
        // The DISCOVERY half. Same projection, one per held item, so a screen
        // can list what is held without a caller having to guess a
        // (transfer_id, item_index) pair the user has never seen.
        IpcRequest::ListQuarantineReports => match state.engine().await {
            Err(e) => e,
            Ok(engine) => match engine.list_quarantine_reports() {
                Ok(reports) => json(serde_json::Value::Array(
                    reports.iter().map(quarantine_report_json).collect(),
                )),
                Err(e) => err(e),
            },
        },
        IpcRequest::DeleteQuarantined {
            transfer_id,
            item_index,
        } => match state.engine().await {
            Err(e) => e,
            Ok(engine) => match parse_id(&transfer_id).and_then(|id| {
                match engine.delete_quarantined_item(id, item_index) {
                    Ok(()) => Ok(()),
                    Err(e) => Err(err(e)),
                }
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
        IpcRequest::SelfProfile => match state.engine().await {
            Err(e) => e,
            Ok(engine) => {
                let (name, device_id) = engine.self_profile().await;
                // baseName is the user's own name, before LAN collision
                // resolution. A Settings box prefills from it, so a device
                // that resolved to "Rustic Otter · D2Dp" still shows "D2Dp".
                let base_name = engine.base_display_name().await;
                json(serde_json::json!({
                    "name": name,
                    "baseName": base_name,
                    "deviceId": hex::encode(device_id),
                }))
            }
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
                return err(NOT_STARTED);
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
        IpcRequest::Wake => match state.engine().await {
            Err(e) => e,
            Ok(engine) => {
                engine.background_wake();
                IpcResponse::Ok
            }
        },
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

/// The store-injecting entry point on Windows, refused for the same reason as
/// `serve_with` above: there is no named-pipe server, so there is nothing for a
/// store to be an input TO. It exists so the ungated `main.rs` call site
/// resolves on every target instead of failing to compile.
#[cfg(windows)]
pub async fn serve_with_store(_path: &Path, _store: Arc<dyn SecretStore>) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "named-pipe server not implemented; see Task 10",
    ))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// B6: a user attaches the bundle to a bug report, and its `recent log`
    /// section is a ring buffer of FORMATTED lines. Asserting on the ring is
    /// therefore asserting on the exact bytes the user reads, not on some side
    /// channel.
    ///
    /// `init_tracing` is a process-global `try_init`, and the tests below run
    /// on many threads, so the losers of that race are a real possibility: a
    /// test that lost would install nothing and then assert on an empty ring.
    /// The `Once` makes the first caller do the install and makes every other
    /// caller wait for it to finish. Lines from a concurrent test are tolerated
    /// because the assertions are `any(..)`, never an exact set.
    fn capture_log() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            debug_bundle::init_tracing().expect("the first installer in this test binary must win");
        });
    }

    /// Drive the REAL per-connection handler over an in-memory duplex, so
    /// none of these tests binds a listener and none of them needs the
    /// escalated privileges a `bind` does. `client` gets the raw duplex end:
    /// feed it frames with `write_message`, and drop it to hang up.
    async fn serve_over_duplex() -> (tokio::io::DuplexStream, tokio::task::JoinHandle<()>) {
        let (client, server) = tokio::io::duplex(64 * 1024);
        let (rd, wr) = tokio::io::split(server);
        let (events, _rx) = broadcast::channel::<IpcEvent>(16);
        let handler = tokio::spawn(serve_connection(
            Arc::new(DaemonState::new()),
            Arc::new(events),
            rd,
            wr,
        ));
        (client, handler)
    }

    /// The headline defect: an IPC error was answered to the client and then
    /// dropped on the floor, so the bundle had nothing to show.
    #[test]
    fn an_ipc_error_reaches_the_debug_bundles_recent_log() {
        capture_log();
        let resp = err("data_dir /nope: permission denied");
        // The ANSWER is unchanged: logging is additive, the client's error
        // text is the contract packages/core asserts on.
        assert!(matches!(
            &resp,
            IpcResponse::Error { message } if message == "data_dir /nope: permission denied"
        ));
        let lines = debug_bundle::recent_log().snapshot();
        assert!(
            lines.iter().any(|l| l.contains("permission denied")),
            "err() logged nothing: {lines:?}"
        );
    }

    /// A peer-controlled string reaches err(): `PairingBundle::from_cbor`
    /// decodes bytes the client sent, and a ciborium error embeds the value
    /// it choked on. The IPC frame cap is 4 MiB, so an untruncated line would
    /// put megabytes into each of 512 ring slots. Bounded, and the front of
    /// the message (the part that names the failure) survives.
    #[test]
    fn a_peer_controlled_error_message_is_capped_in_the_log() {
        capture_log();
        let _ = err(format!("BEGIN{}END", "x".repeat(100_000)));
        let lines = debug_bundle::recent_log().snapshot();
        let line = lines
            .iter()
            .find(|l| l.contains("BEGIN"))
            .unwrap_or_else(|| panic!("the oversized message was not logged at all: {lines:?}"));
        assert!(
            line.chars().count() <= 1024,
            "logged {} chars, expected a cap",
            line.chars().count()
        );
    }

    /// The bug had FOUR hand-built `IpcResponse::Error` sites that never went
    /// through `err()` (both NOT_STARTED returns and both `parse_id`
    /// failures). Wiring only `err()` would leave the single most common
    /// daemon error -- a request before Start -- still invisible.
    #[tokio::test]
    async fn the_errors_that_bypass_err_are_logged_too() {
        capture_log();
        let state = DaemonState::new();
        // Every engine-backed request before Start. This is the error a user
        // hits when the app and the daemon disagree about startup order.
        assert!(state.engine().await.is_err());
        // A malformed id from the client.
        assert!(parse_id("not hex").is_err());
        assert!(parse_id("aabb").is_err());
        let lines = debug_bundle::recent_log().snapshot();
        assert!(
            lines.iter().any(|l| l.contains(NOT_STARTED)),
            "engine-not-started was not logged: {lines:?}"
        );
        assert_eq!(
            lines.iter().filter(|l| l.contains("32 hex chars")).count(),
            2,
            "both parse_id rejections must be logged: {lines:?}"
        );
    }

    /// B6: the reply-write path, driven through the REAL handler over a
    /// duplex. The client end is dropped, so the handler's write fails
    /// deterministically -- no timing, no listener, no escalation.
    ///
    /// A real accepted socket CANNOT reach this: the reply to any request a
    /// client can send before `Start` is ~50 bytes and a Unix socket's kernel
    /// buffer swallows that with no reader, so the daemon lands on its READ
    /// arm instead. That is why this is a duplex test and not an ipc_smoke one.
    #[tokio::test]
    async fn a_reply_that_cannot_be_written_is_logged() {
        capture_log();
        let (mut client, handler) = serve_over_duplex().await;
        // The engine was never started, so the reply is the NOT_STARTED error:
        // this drives the err() line AND the reply-write line together.
        write_message(&mut client, &IpcMessage::Request(IpcRequest::ListInbox))
            .await
            .unwrap();
        // The client vanishes, so the reply has nowhere to go.
        drop(client);
        handler.await.unwrap();

        let lines = debug_bundle::recent_log().snapshot();
        let joined = lines.join("\n");
        assert!(
            joined.contains("ipc reply write failed"),
            "the failed reply left no line in the ring: {lines:?}"
        );
    }

    /// B6: the other silent break. A peer that sends a magic and then a body
    /// it cannot finish used to close the connection with a bare `break`,
    /// which is the shape of a crash from the outside. Nothing at all reached
    /// the bundle.
    #[tokio::test]
    async fn an_unreadable_frame_ends_the_connection_with_a_line_in_the_bundle() {
        capture_log();
        use tokio::io::AsyncWriteExt;
        let (mut client, handler) = serve_over_duplex().await;
        // Magic, a length prefix, then far fewer bytes than it claims: the
        // read future returns Err, not Ok(None).
        client.write_all(&daak_ipc::IPC_MAGIC).await.unwrap();
        client
            .write_all(&(2 * 1024 * 1024u32).to_be_bytes())
            .await
            .unwrap();
        client.flush().await.unwrap();
        // Then the peer goes, so the handler's read sees the short frame.
        drop(client);
        handler.await.unwrap();

        let lines = debug_bundle::recent_log().snapshot();
        let joined = lines.join("\n");
        assert!(
            joined.contains("unreadable frame") && joined.contains("early eof"),
            "the truncated frame left no line in the ring: {lines:?}"
        );
    }

    /// B6: the branch the brief named explicitly. An old app is answered with
    /// the lowest major this build speaks and then dropped -- from the app's
    /// side that is a closed socket and nothing else, and from the bundle's
    /// side it used to be nothing at all, so "my app is too old" was
    /// unanswerable from a bug report.
    ///
    /// A real major bump is not reproducible in a test, so the frame is
    /// hand-built the way daak-ipc's own tests do it: the magic, a length
    /// prefix, and a CBOR body whose `v` has a foreign major.
    #[tokio::test]
    async fn a_version_mismatch_is_logged_even_though_the_reply_succeeds() {
        capture_log();
        let (mut client, handler) = serve_over_duplex().await;
        // (2 << 8) | 0: major 2, which this build (major 1) refuses.
        let mut inner = Vec::new();
        ciborium::into_writer(
            &serde_json::json!({
            "v": 512u64,
            "msg": { "Request": { "Devices": null } },
            }),
            &mut inner,
        )
        .unwrap();
        let mut frame = Vec::new();
        frame.extend_from_slice(&daak_ipc::IPC_MAGIC);
        frame.extend_from_slice(&(inner.len() as u32).to_be_bytes());
        frame.extend_from_slice(&inner);
        use tokio::io::AsyncWriteExt;
        client.write_all(&frame).await.unwrap();
        client.flush().await.unwrap();

        // The client still gets its answer: the log line is ADDITIVE.
        let answer = read_message(&mut client).await.unwrap().unwrap();
        assert!(
            matches!(
                answer,
                IpcMessage::Response(IpcResponse::UpdateRequired { .. })
            ),
            "the daemon must still answer an old app: {answer:?}"
        );
        drop(client);
        handler.await.unwrap();

        let lines = debug_bundle::recent_log().snapshot();
        let joined = lines.join("\n");
        assert!(
            joined.contains("version mismatch"),
            "the version refusal left no line in the ring: {lines:?}"
        );
    }

    /// B6 review I-1a, as a REGRESSION GUARD and not a reproduction. The review
    /// reported that `SetPresence` let a 1 MB peer string through as a
    /// 1,000,049-char ring line. That was a STALE READING: `err()` caps its
    /// own argument (`log_line(&message)`), and this arm reaches the ring only
    /// through `err()`, so the line is already bounded. Measured on this tree
    /// before any fix: 1,000,000 chars in, 579 out.
    ///
    /// The test is still worth its place, because it is the only one that pins
    /// the END-TO-END bound on a real `dispatch` arm -- oversized peer state
    /// reaches the ring bounded AND the client still receives the FULL original
    /// text. The two halves matter separately: capping the response as well as
    /// the log would be a silent protocol change, and nothing else says that
    /// does not happen.
    ///
    /// The funnel invariant itself is pinned by
    /// `err_bounds_whatever_it_is_handed`.
    #[tokio::test]
    async fn an_oversized_presence_state_is_capped_in_the_log_but_not_in_the_reply() {
        capture_log();
        let state = DaemonState::new();
        let (events, _rx) = broadcast::channel::<IpcEvent>(16);
        let hostile = "x".repeat(1_000_000);
        let resp = dispatch(
            &state,
            &events,
            IpcRequest::SetPresence {
                state: hostile.clone(),
            },
        )
        .await;

        // The answer the client sees is unchanged, megabytes and all.
        let IpcResponse::Error { message } = &resp else {
            panic!("a bogus presence must be refused, got {resp:?}");
        };
        assert_eq!(
            message,
            &format!("presence state must be 'online' or 'away', got {hostile:?}"),
            "the CLIENT's error text must not be truncated"
        );

        let lines = debug_bundle::recent_log().snapshot();
        let line = lines
            .iter()
            .find(|l| l.contains("presence state must be"))
            .unwrap_or_else(|| panic!("the refusal was not logged at all: {lines:?}"));
        assert!(
            line.chars().count() <= 1024,
            "the ring line is {} chars; a peer must not be able to evict the ring",
            line.chars().count()
        );
    }

    /// B6 review I-1a, second pin: the invariant at the FUNNEL, which is where
    /// the bound actually lives. `err()` applies `log_line` to whatever it is
    /// handed, so every one of its ~25 call sites is bounded without each site
    /// having to remember. That is the guarantee; the per-site tests only
    /// happen to observe it.
    ///
    /// Driven straight through `err()` rather than through a request arm, so
    /// it is a separate pin from the `SetPresence` guard above and would still
    /// bite if every arm were rewritten. The input is deliberately NOT a
    /// String: it is a bare `Display`, because `err()` takes `impl Display`
    /// and the bound must not depend on the argument happening to be one.
    #[test]
    fn err_bounds_whatever_it_is_handed() {
        capture_log();
        struct Hostile;
        impl std::fmt::Display for Hostile {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                for _ in 0..1_000_000 {
                    f.write_str("x")?;
                }
                Ok(())
            }
        }
        let resp = err(Hostile);
        // The client is answered in full: the cap is for the RING, and
        // shortening the response would be a protocol change.
        let IpcResponse::Error { message } = &resp else {
            panic!("err() must still answer with an Error, got {resp:?}");
        };
        assert_eq!(
            message.chars().count(),
            1_000_000,
            "err() must hand the client the WHOLE message"
        );

        let lines = debug_bundle::recent_log().snapshot();
        let line = lines
            .iter()
            .find(|l| l.contains("ipc error: xxx"))
            .unwrap_or_else(|| panic!("err() logged nothing: {lines:?}"));
        assert!(
            line.chars().count() <= 1024,
            "the funnel let {} chars into the ring; the cap is not being applied",
            line.chars().count()
        );
    }

    /// B6 review M-2: the one B6 line with no coverage. A client that speaks
    /// the server's half of the protocol -- a `Response` or an `Event` where
    /// a `Request` belongs -- used to be a bare `break`, so a misbehaving or
    /// confused app looked exactly like a daemon that hung up for no reason.
    ///
    /// Asserts BOTH halves of the behaviour, because either alone is easy to
    /// get wrong: the line lands in the ring, AND the client gets no reply at
    /// all. A daemon that logged the refusal and then answered it would be a
    /// different (also wrong) protocol, and this pins that it does not.
    #[tokio::test]
    async fn a_non_request_frame_is_logged_and_gets_no_reply() {
        capture_log();
        let (mut client, handler) = serve_over_duplex().await;
        // A well-formed frame the daemon can decode perfectly well, carrying
        // the wrong half of the protocol. Nothing is malformed here, which is
        // what makes this a distinct path from the unreadable-frame test.
        write_message(&mut client, &IpcMessage::Response(IpcResponse::Ok))
            .await
            .unwrap();

        // No reply: the handler breaks, so the read side sees a clean EOF
        // rather than a frame.
        assert!(
            read_message(&mut client).await.unwrap().is_none(),
            "a non-request frame must get no reply"
        );
        drop(client);
        handler.await.unwrap();

        let lines = debug_bundle::recent_log().snapshot();
        let joined = lines.join("\n");
        assert!(
            joined.contains("non-request frame"),
            "the non-request frame left no line in the ring: {lines:?}"
        );
    }

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
    // The injected store when there is one, else the 0600 file store under the
    // client's data_dir -- the pre-Task-13 behaviour, unchanged for every
    // caller that did not ask for a store.
    let store: Arc<dyn SecretStore> = match &state.key_store {
        Some(s) => s.clone(),
        None => match daak_core::crypto::secret_store::PersistentFileStore::new(dir.join("keys")) {
            Ok(s) => Arc::new(s),
            Err(e) => return err(e),
        },
    };
    let identity = match daak_core::crypto::identity::import_from_store(store.as_ref()) {
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
