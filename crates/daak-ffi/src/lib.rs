//! UniFFI surface over daak-core.
//!
//! The UDL in daak.udl owns the ABI: every type named there must also be
//! declared here under the same name, and uniffi::include_scaffolding! attaches
//! the FFI lowering to those declarations.
// uniffi 0.28's UDL template emits a doc comment followed by blank lines, which
// trips clippy::empty_line_after_doc_comments. The file is generated, so the
// lint is allowed crate-wide rather than patched upstream.
#![allow(clippy::empty_line_after_doc_comments)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use daak_core::crypto::identity::{import_from_store, verify_static_binding};
use daak_core::discovery::PresenceState;
use daak_core::engine::{Engine, EngineConfig, EngineEvent};
use daak_core::manifest::{from_picked_paths, DeviceRef, Manifest, CHUNK_SIZE_DEFAULT};
use daak_core::pairing::{PairMode, PairingBundle};
use daak_core::store::Db;
use daak_core::CoreError;

mod secure_store;
pub use secure_store::FfiSecretStore;

// ---- Types named by daak.udl. include_scaffolding! lowers these; the shapes
// ---- here must stay in step with the UDL or the FFI symbols do not match.

#[derive(Debug, thiserror::Error)]
pub enum FfiError {
    #[error("{0}")]
    Engine(String),
    #[error("{0}")]
    Protocol(String),
}

/// The OS-keystore callback's error. A SEPARATE type from FfiError because UDL
/// can only declare a fielded error through the `[Error] interface` syntax,
/// and because every engine failure still has to surface as Engine/Protocol.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FfiStoreError {
    // Field named `reason`, not `message`: see the note on the UDL declaration.
    // uniffi 0.28.3's Kotlin ErrorTemplate emits a fielded-error field as a
    // `val` on a kotlin.Exception subclass, where `message` collides with
    // Throwable.message and the bindings do not compile.
    #[error("{reason}")]
    Store { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceFoundEvent {
    pub device_id: String,
    pub name: String,
    pub addr: String,
    pub online: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceStateEvent {
    pub device_id: String,
    pub online: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingSasEvent {
    pub peer_device_id: String,
    pub sas: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingDoneEvent {
    pub device_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgressEvent {
    pub transfer_id: String,
    pub bytes_done: u64,
    pub bytes_total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferItemEvent {
    pub transfer_id: String,
    pub item_index: u32,
    pub state: String,
    /// The engine's `Option<String>` (`daak-core/src/engine.rs:80`) is `String`
    /// here because UDL has no optional field on a dictionary, and the UDL
    /// dictionary cannot express it either (`daak.udl:57`). DELIBERATE, not an
    /// oversight: `None` -- a non-binary item that is never materialised --
    /// arrives here as the EMPTY STRING, and an empty string is NOT a real
    /// destination. Do not "fix" this by making a real path empty instead, and
    /// do not add a sentinel: the JS side already reads it as `destPath?: string`
    /// and ReceivedItemRow treats a missing value as "no file". Changing the
    /// value on the wire is a wire change, not a cleanup.
    pub dest_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoneEvent {
    pub transfer_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailedEvent {
    pub transfer_id: String,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboxReceivedEvent {
    pub payload_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncompatiblePeerEvent {
    pub peer_device_id: String,
    pub peer_name: String,
    /// The version the peer advertised in its mDNS TXT record.
    pub peer_version: u16,
    /// This build's manifest version, i.e. what the peer would need.
    pub our_version: u16,
}

/// One tagged union for every engine signal, so the JS callback has a single
/// shape to switch on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FfiEvent {
    DeviceFound { data: DeviceFoundEvent },
    DeviceState { data: DeviceStateEvent },
    PairingSas { data: PairingSasEvent },
    PairingDone { data: PairingDoneEvent },
    TransferProgress { data: ProgressEvent },
    TransferItem { data: TransferItemEvent },
    TransferDone { data: DoneEvent },
    TransferFailed { data: FailedEvent },
    InboxReceived { data: InboxReceivedEvent },
    IncompatiblePeer { data: IncompatiblePeerEvent },
}

/// The one method JS must implement to receive engine signals. The generated
/// scaffolding supplies the foreign (vtable) side. Send + Sync are declared here
/// rather than added at the use site: the event task moves the sink onto a
/// multithreaded runtime, so the sink has to satisfy both.
///
/// The UDL callback carries an FfiEvent, not a string, so it cannot carry the
/// event JSON itself. The platform sink calls ffi_event_json on what it gets
/// here; packages/core/src/engine/types.ts is the other end of that JSON.
pub trait EventSink: Send + Sync {
    fn on_event(&self, event: FfiEvent);
}

/// The UDL-declared `SecureStore` callback: the OS keystore, as the platform
/// implements it. Values are base64 STRINGS because the UDL has no byte-string
/// type; `Ok(None)` from `get` is "no such key", which is what a first launch
/// looks like, and is not an error. A keystore failure is FfiStoreError, never a
/// fallback (R40(c)).
///
/// Declared here (and not `pub use`d from the scaffolding) because the two
/// SecretStore traits collide by name: this one is base64 strings, daak-core's
/// is raw bytes.
pub trait SecureStore: Send + Sync {
    fn get(&self, key: String) -> Result<Option<String>, FfiStoreError>;
    fn set(&self, key: String, value: String) -> Result<(), FfiStoreError>;
    fn delete(&self, key: String) -> Result<(), FfiStoreError>;
}

/// Device and transfer ids cross the FFI boundary as lowercase hex, which is
/// what the JS layer stores and hands back. Both are 16 bytes, so they share
/// one parser.
pub fn to_hex(bytes: &[u8]) -> String {
    hex::encode(bytes)
}

pub fn parse_id(s: &str) -> Result<[u8; 16], FfiError> {
    hex::decode(s)
        .map_err(|e| FfiError::Protocol(e.to_string()))?
        .try_into()
        .map_err(|_| FfiError::Protocol("id must be 32 hex chars".into()))
}

fn engine_err(e: impl Into<CoreError>) -> FfiError {
    FfiError::Engine(e.into().to_string())
}

fn protocol_err(e: impl std::fmt::Display) -> FfiError {
    FfiError::Protocol(e.to_string())
}

/// The listTransfers filter, as the UDL's string method receives it. The TS
/// side sends `JSON.stringify(filter ?? {})`, so "" (a caller with no filter
/// at all) and "{}" both mean list everything and decode to `None`.
///
#[derive(Debug, Clone, PartialEq)]
pub struct TransferFilter {
    pub state: Option<String>,
    pub peer_device_id: Option<[u8; 16]>,
}

/// An absent or fully empty filter is `None`: one SQL with a NULL-means-unset
/// test covers "list everything" and every filter combination, so the daemon
/// and this crate agree on exactly one query shape.
///
/// Key names are camelCase because this JSON is authored by
/// packages/core/src/engine/types.ts, not by a serde derive, so the default
/// snake_case renaming the FFI and IPC pairs rely on does not apply. Read
/// through serde_json::Value rather than a #[derive(Deserialize)] because
/// daak-ffi deliberately depends on serde_json only: adding serde here for one
/// two-field struct is not worth a dependency. The peer id is validated HERE
/// rather than at the SQL layer so a typo'd hex cannot silently degrade into
/// "no peer filter".
pub fn parse_transfer_filter(json: &str) -> Result<Option<TransferFilter>, FfiError> {
    if json.trim().is_empty() {
        return Ok(None);
    }
    let v: serde_json::Value = serde_json::from_str(json).map_err(protocol_err)?;
    let obj = v
        .as_object()
        .ok_or_else(|| FfiError::Protocol("listTransfers filter must be a JSON object".into()))?;
    // An unknown key is a caller typo that would otherwise widen the query, so
    // reject it rather than ignore it: a filter naming `peerId` must not read
    // as "no peer filter" and return the whole list.
    for k in obj.keys() {
        if !matches!(k.as_str(), "state" | "peerDeviceId") {
            return Err(FfiError::Protocol(format!(
                "unknown listTransfers filter key {k:?}; expected state or peerDeviceId"
            )));
        }
    }
    let state = match obj.get("state") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(other) => {
            return Err(FfiError::Protocol(format!(
                "listTransfers filter state must be a string, got {other}"
            )))
        }
    };
    let peer_device_id = match obj.get("peerDeviceId") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(s)) => Some(parse_id(s)?),
        Some(other) => {
            return Err(FfiError::Protocol(format!(
                "listTransfers filter peerDeviceId must be a string, got {other}"
            )))
        }
    };
    if state.is_none() && peer_device_id.is_none() {
        return Ok(None);
    }
    Ok(Some(TransferFilter {
        state,
        peer_device_id,
    }))
}

/// 'online' | 'away' -- the states a device declares about ITSELF. Offline is
/// what a PEER says about us, so accepting it here would let a caller claim a
/// liveness the engine has no way to honour: nothing withdraws this device's
/// mDNS record on Offline, so the claim would be a lie on the wire.
pub fn parse_presence_state(s: &str) -> Result<PresenceState, FfiError> {
    match s {
        "online" => Ok(PresenceState::Online),
        "away" => Ok(PresenceState::Away),
        other => Err(FfiError::Protocol(format!(
            "presence state must be 'online' or 'away', got {other:?}"
        ))),
    }
}

/// One transfers row as the TransferSummary TS type. A free function so the
/// shape is testable without a live engine, and so daakd -- which has its own
/// dispatch -- can reuse it instead of inventing a second projection that
/// would drift from this one on the next field change.
pub fn transfer_summary_json(row: &daak_core::store::transfers::TransferRow) -> serde_json::Value {
    serde_json::json!({
        // transferId is the row's transfer_id. For a SEND it is the payload id
        // (the outbox primary key), which is what cancel/retry take; the UI's
        // `transferId` is therefore always something it can act on.
        "transferId": to_hex(&row.transfer_id),
        "peerDeviceId": to_hex(&row.peer_device_id),
        "direction": row.direction,
        "kind": row.kind,
        "state": row.state,
        "bytesDone": row.bytes_done,
        "bytesTotal": row.bytes_total,
        "itemCount": row.item_count,
        "updatedAt": row.updated_at,
    })
}

/// One inbox_history row as the InboxEntry TS type. saved_paths is a JSON
/// string in SQLite and a string[] in TS, so it is parsed rather than passed
/// through as a quoted blob. A value that will not parse becomes `null`, NOT
/// `[]`: `[]` is a real answer ("this payload saved no files") and a corrupt
/// row must not be indistinguishable from it -- saved_paths is the one field
/// the inbox row exists to carry. daakd mirrors this exactly.
pub fn inbox_entry_json(row: &daak_core::store::inbox::InboxRow) -> serde_json::Value {
    let saved_paths: serde_json::Value = match serde_json::from_str(&row.saved_paths) {
        Ok(v) => v,
        // No log line: daak-ffi has no tracing dependency, and the null IS the
        // signal. Matches daakd's identical function exactly.
        Err(_) => serde_json::Value::Null,
    };
    serde_json::json!({
        "payloadId": to_hex(&row.id),
        "transferId": to_hex(&row.transfer_id),
        "peerDeviceId": to_hex(&row.peer_device_id),
        "kind": row.kind,
        "itemCount": row.item_count,
        "summary": row.summary,
        "receivedAt": row.received_at,
        "savedPaths": saved_paths,
    })
}

/// The identity store: one 0600 file per key under <data_dir>/keys, so the
/// device id and static key survive a restart and pairing does not silently
/// break on relaunch.
///
/// This was a private `FileKeyStore` here, line-for-line identical to
/// daak-core's `PersistentFileStore` -- two implementations of the one piece of
/// the identity that both deployments MUST agree on, free to drift. Use core's.
/// ponytail: plaintext files guarded only by mode bits (0600 comes from
/// OpenOptions::mode, which applies only on CREATE, and is Unix-only). The
/// upgrade path is the OS-keystore TurboModule (iOS Keychain / Android
/// Keystore / DPAPI), Phase 5.
pub use daak_core::crypto::secret_store::PersistentFileStore as FileKeyStore;

pub struct DaakEngine {
    rt: tokio::runtime::Runtime,
    // UDL methods take &self, so the engine slot needs interior mutability.
    engine: Mutex<Option<Arc<Engine>>>,
    sink: Arc<dyn EventSink + Send + Sync>,
    // Fan-out for inbound pairing SAS. Engine::accept_pairing_once() holds the
    // engine's pairing_rx mutex for the whole wait, so exactly ONE task may
    // ever wait on it; it emits the event AND republishes here so
    // accept_pairing() can hand the same SAS back to a caller that asked.
    pairing_sas: Mutex<Option<tokio::sync::broadcast::Sender<String>>>,
    // Set by the [Name=new_with_store] constructor only. `new` leaves it None
    // and start() then falls back to the 0600 file store exactly as before
    // (R40(a)): a MemorySecretStore default would mint a new Ed25519 identity on
    // every launch and re-pair the device forever. The UDL callback is adapted
    // to daak-core's byte-oriented SecretStore HERE, at construction, so
    // start() deals in one type and the adapter's lifetime is the engine's.
    store: Option<Arc<dyn daak_core::crypto::secret_store::SecretStore>>,
}

/// The name the plan and the JS layer use for the engine handle.
pub type FfiEngine = DaakEngine;

impl DaakEngine {
    /// UniFFI 0.28 fixes this signature: a Box<dyn EventSink> in and an
    /// Arc<Self> out, with no Result -- the generated scaffolding has no way to
    /// lift a constructor error. Building the runtime cannot fail in practice.
    pub fn new(sink: Box<dyn EventSink>) -> Self {
        // Re-pinning is a no-op today (EventSink: Send + Sync) but keeps the
        // constructor honest if the supertraits are ever dropped.
        let sink: Box<dyn EventSink + Send + Sync> = sink;
        Self::with_core_store(None, sink)
    }

    /// The mobile constructor: the identity lives in the OS keystore. Same
    /// infallible shape as `new` for the same reason (UniFFI 0.28 cannot lift a
    /// constructor error, R39); the keystore itself is only touched in
    /// `start`, where a failure CAN reject the start (R40(c)).
    pub fn with_store(store: Box<dyn SecureStore + Send + Sync>, sink: Box<dyn EventSink>) -> Self {
        let sink: Box<dyn EventSink + Send + Sync> = sink;
        // UniFFI hands the callback over boxed; the engine is reached from
        // several threads, so it is held shared from here on.
        let adapted = Arc::new(FfiSecretStore::new(Arc::from(store)));
        Self::with_core_store(Some(adapted), sink)
    }

    /// The UDL declares this as `[Name=new_with_store]`, so uniffi codegen
    /// looks for a Rust symbol spelled exactly that. One line of forwarding so
    /// the Rust-side name can stay the plainer `with_store` (R39).
    pub fn new_with_store(
        store: Box<dyn SecureStore + Send + Sync>,
        sink: Box<dyn EventSink>,
    ) -> Self {
        Self::with_store(store, sink)
    }

    /// The one place a `DaakEngine` is built. `store` is already a core
    /// SecretStore; `None` means "no store was injected", which start()
    /// answers with the 0600 file store under the data_dir (R40(a)).
    fn with_core_store(
        store: Option<Arc<dyn daak_core::crypto::secret_store::SecretStore>>,
        sink: Box<dyn EventSink + Send + Sync>,
    ) -> Self {
        DaakEngine {
            rt: tokio::runtime::Runtime::new().expect("tokio runtime"),
            engine: Mutex::new(None),
            sink: Arc::from(sink),
            pairing_sas: Mutex::new(None),
            store,
        }
    }

    pub fn start(
        &self,
        data_dir: String,
        display_name: String,
        listen_port: u16,
    ) -> Result<(), FfiError> {
        let dir = PathBuf::from(&data_dir);
        std::fs::create_dir_all(&dir).map_err(engine_err)?;
        // A supplied keystore wins; otherwise the 0600 file store that has
        // always been the default here (R40(a)).
        let identity = match &self.store {
            Some(store) => import_from_store(store.as_ref()).map_err(engine_err)?,
            None => import_from_store(&FileKeyStore::new(dir.join("keys")).map_err(engine_err)?)
                .map_err(engine_err)?,
        };
        let db = Db::open(&dir.join("daak.db")).map_err(engine_err)?;
        db.migrate().map_err(engine_err)?;
        let cfg = EngineConfig {
            display_name,
            listen_addr: format!("0.0.0.0:{listen_port}")
                .parse()
                .map_err(protocol_err)?,
            out_dir: dir.join("downloads"),
            identity,
            db: Arc::new(db),
        };
        let engine = Arc::new(self.rt.block_on(Engine::start(cfg)).map_err(engine_err)?);

        let mut events = engine.events();
        let sink = self.sink.clone();
        self.rt.spawn(async move {
            while let Ok(ev) = events.recv().await {
                sink.on_event(to_ffi_event(ev));
            }
        });

        // Exactly one pairing waiter, ever. accept_pairing_once() locks the
        // engine's pairing_rx for the whole await, so a second waiter would
        // block forever behind this one.
        let (sas_tx, _) = tokio::sync::broadcast::channel(8);
        *self.pairing_sas.lock().unwrap() = Some(sas_tx.clone());
        let sink = self.sink.clone();
        let pairing_engine = engine.clone();
        self.rt.spawn(async move {
            loop {
                match pairing_engine.accept_pairing_once().await {
                    Ok(sas) => {
                        let _ = sas_tx.send(sas.clone());
                        sink.on_event(to_pairing_sas_event(sas));
                    }
                    Err(_) => return,
                }
            }
        });
        *self.engine.lock().unwrap() = Some(engine);
        Ok(())
    }

    fn engine(&self) -> Result<Arc<Engine>, FfiError> {
        self.engine
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| FfiError::Engine("engine not started".into()))
    }

    pub fn pairing_bundle(&self) -> Result<String, FfiError> {
        let bundle = self.rt.block_on(self.engine()?.pairing_bundle());
        pairing_bundle_json(&bundle)
    }

    /// C2: arm the HOST half of QR pairing. The host has already scanned the
    /// joiner's bundle, so this takes the same bundle bytes `pair_with` takes
    /// and hands them to Engine::offer_pairing, which sets pending_pairing for
    /// the accept loop. Re-armable by design: offer_pairing REPLACES the slot,
    /// so a user whose first attempt failed (or who wants to pair a different
    /// device) re-offers without restarting the engine. One peer at a time --
    /// that is the engine's existing shape, not a limit this method adds.
    pub fn offer_pairing(&self, bundle_cbor: Vec<u8>) -> Result<(), FfiError> {
        let bundle = PairingBundle::from_cbor(&bundle_cbor).map_err(protocol_err)?;
        // PairingBundle::from_cbor does NOT check the identity binding; the
        // engine re-verifies it inside pairing::pair, but a bundle that cannot
        // possibly be valid should not silently replace a good pending slot.
        if !verify_static_binding(
            &bundle.identity.ed25519,
            &bundle.identity.x25519,
            &bundle.identity.static_sig,
        ) {
            return Err(protocol_err("pairing bundle identity binding failed"));
        }
        self.rt
            .block_on(self.engine()?.offer_pairing(bundle, PairMode::Qr, None))
            .map_err(engine_err)
    }

    /// Second review: the host arm spec 3.3 Mode A actually needs, and it takes
    /// NO bundle.
    ///
    /// The QR flow is asymmetric. Only the JOINER scans, so only the joiner
    /// ever holds the host's bundle, and the sanctioned flow never gives the
    /// host the joiner's bundle -- which made `offer_pairing` above
    /// unreachable by a real user, and a real user still could not pair. This
    /// arms the accept slot for the FIRST inbound pairing with no peer named.
    ///
    /// TRUST SURFACE, stated plainly: `offer_pairing` verifies a bundle's
    /// identity binding HERE, at the trust boundary, before anything is armed.
    /// With no bundle there is nothing to verify at this boundary, and the host
    /// cannot pre-empt an identity substitution. What still holds is in the
    /// engine: the in-band identity is checked against the hello's device id
    /// and `verify_static_binding`-ed, the Noise XX handshake authenticates the
    /// peer to that identity, spec 3.5 key confirmation proves it holds the
    /// session, and the SAS is derived from a handshake hash bound to both
    /// static keys. What is GIVEN UP is the host's ability to know in advance
    /// which device it is accepting; the user comparing the two SAS values is
    /// now the only thing binding that identity to a human. `offer_pairing`
    /// remains available and remains the stronger path wherever a bundle is in
    /// hand.
    ///
    /// One-shot: the accept loop takes the slot, so arm again for another
    /// device. Replaces any pending arm, like `offer_pairing`.
    pub fn arm_host_pairing(&self) -> Result<(), FfiError> {
        self.rt
            .block_on(self.engine()?.offer_inbound_pairing(PairMode::Qr))
            .map_err(engine_err)
    }

    pub fn pair_with(&self, addr: String, bundle_cbor: Vec<u8>) -> Result<String, FfiError> {
        let bundle = PairingBundle::from_cbor(&bundle_cbor).map_err(protocol_err)?;
        let addr: std::net::SocketAddr = addr.parse().map_err(protocol_err)?;
        let (sas, peer) = self
            .rt
            .block_on(self.engine()?.pair_with(addr, bundle))
            .map_err(engine_err)?;
        let json = serde_json::json!({ "sas": sas, "peer_device_id": to_hex(&peer) });
        serde_json::to_string(&json).map_err(protocol_err)
    }

    /// Block until the next inbound pairing completes and return its SAS.
    /// The event is pushed too, so an app that prefers the callback can ignore
    /// this method; a caller that awaits it just gets the same SAS early.
    pub fn accept_pairing(&self) -> Result<String, FfiError> {
        let mut rx = self
            .pairing_sas
            .lock()
            .unwrap()
            .as_ref()
            .ok_or_else(|| FfiError::Engine("engine not started".into()))?
            .subscribe();
        self.engine()?;
        self.rt.block_on(async move {
            rx.recv()
                .await
                .map_err(|e| FfiError::Engine(format!("pairing stream closed: {e}")))
        })
    }

    pub fn send_text(&self, peer_id: String, text: String) -> Result<String, FfiError> {
        let engine = self.engine()?;
        let mut manifest = Manifest::text(&text);
        manifest.sender = device_ref(&engine, self.rt.block_on(engine.display_name()));
        let id = self
            .rt
            .block_on(engine.enqueue_outbox_send(parse_id(&peer_id)?, manifest, vec![]))
            .map_err(engine_err)?;
        Ok(to_hex(&id))
    }

    pub fn send_files(&self, peer_id: String, paths: Vec<String>) -> Result<String, FfiError> {
        let engine = self.engine()?;
        // B1: the share sheet hands over directories too, and a directory is not
        // a file. from_picked_paths expands a folder into one item per file.
        let picked: Vec<std::path::PathBuf> = paths.iter().map(std::path::PathBuf::from).collect();
        let (manifest, sources) = from_picked_paths(
            device_ref(&engine, self.rt.block_on(engine.display_name())),
            &picked,
            CHUNK_SIZE_DEFAULT,
        )
        .map_err(engine_err)?;
        let id = self
            .rt
            .block_on(engine.enqueue_outbox_send(parse_id(&peer_id)?, manifest, sources))
            .map_err(engine_err)?;
        Ok(to_hex(&id))
    }

    pub fn list_devices(&self) -> Result<String, FfiError> {
        let devices = self.rt.block_on(self.engine()?.devices());
        // SocketAddr and [u8; 16] have no serde impls, so build the shape by hand.
        // No "online" key: the engine never prunes this map, so any value here
        // would be fabricated. device.state events own liveness, and the TS
        // DeviceInfo type leaves the field optional for exactly this reason.
        let json: Vec<serde_json::Value> = devices
            .iter()
            .map(|d| {
                serde_json::json!({
                    "deviceId": to_hex(&d.device_id),
                    "name": d.name,
                    "addr": d.addr.to_string(),
                })
            })
            .collect();
        serde_json::to_string(&json).map_err(protocol_err)
    }

    pub fn cancel(&self, transfer_id: String) -> Result<(), FfiError> {
        // Parse before the engine check: a malformed id is a caller bug whether
        // or not the engine happens to be running.
        let id = parse_id(&transfer_id)?;
        self.engine()?.cancel(id).map_err(engine_err)
    }

    pub fn retry(&self, transfer_id: String) -> Result<(), FfiError> {
        let id = parse_id(&transfer_id)?;
        self.engine()?.retry(id).map_err(engine_err)
    }

    /// Re-arm ONE item of a transfer. The per-item half of `retry`: that item's
    /// hash did not match on arrival, so re-running the whole transfer would
    /// restart every file to fix one.
    ///
    /// PARKED. Nothing on a screen calls it, because it marks the item `pending`
    /// and pokes an outbox that holds OUTBOUND rows only -- an inbound transfer
    /// has nothing to drain -- and the push-only wire protocol has no message a
    /// receiver can send to ask for a file again.
    pub fn retry_item(&self, transfer_id: String, item_index: u32) -> Result<(), FfiError> {
        // Parse before the engine check, exactly as cancel/retry do: a
        // malformed id is a caller bug whether or not the engine is running.
        let id = parse_id(&transfer_id)?;
        self.engine()?
            .retry_item(id, item_index)
            .map_err(engine_err)
    }

    /// What the "Held back" screen shows, as JSON. A free projection so both
    /// bridges can share it (see the note on daakd's copy) and so the shape is
    /// testable without a live engine.
    ///
    /// The two fingerprints are hex strings because the UI renders them in
    /// groups for a person to compare by eye. Everything optional is emitted
    /// as an explicit `null` rather than omitted: the field's ABSENCE would be
    /// indistinguishable from a bridge that forgot it, while a null is the
    /// honest "this device never recorded that".
    pub fn quarantine_report_json(
        report: &daak_core::engine::QuarantineReport,
    ) -> serde_json::Value {
        serde_json::json!({
            "transferId": to_hex(&report.transfer_id),
            "itemIndex": report.item_index,
            "name": report.name,
            "size": report.size,
            "senderName": report.sender_name,
            // The REAL id, so a screen can say "Device aabbccdd" when no
            // paired label was ever recorded. An identifier, not an invented
            // name -- which is exactly why it may stand in for one.
            "senderDeviceId": report.sender_device_id.map(|d| to_hex(&d)),
            "receivedAt": report.received_at,
            "expected": to_hex(&report.expected),
            "actual": to_hex(&report.actual),
            "heldPath": report.held_path,
        })
    }

    pub fn quarantine_report(
        &self,
        transfer_id: String,
        item_index: u32,
    ) -> Result<String, FfiError> {
        let id = parse_id(&transfer_id)?;
        let report = self
            .engine()?
            .quarantine_report(id, item_index)
            .map_err(engine_err)?;
        serde_json::to_string(&Self::quarantine_report_json(&report)).map_err(protocol_err)
    }

    /// Every held-back item, as a JSON array of the same shape
    /// `quarantine_report` returns one of.
    pub fn list_quarantine_reports(&self) -> Result<String, FfiError> {
        let reports = self
            .engine()?
            .list_quarantine_reports()
            .map_err(engine_err)?;
        let json = reports
            .iter()
            .map(Self::quarantine_report_json)
            .collect::<Vec<_>>();
        serde_json::to_string(&json).map_err(protocol_err)
    }

    pub fn delete_quarantined(&self, transfer_id: String, item_index: u32) -> Result<(), FfiError> {
        let id = parse_id(&transfer_id)?;
        self.engine()?
            .delete_quarantined_item(id, item_index)
            .map_err(engine_err)
    }

    /// The optional listTransfers filter, parsed from the JSON string the UDL
    /// method takes. `None` for "" and "{}" -- both mean list everything, and
    /// a filter object with no fields set is the same request.
    pub fn list_transfers(&self, filter_json: String) -> Result<String, FfiError> {
        let filter = parse_transfer_filter(&filter_json)?;
        let engine = self.engine()?;
        let (state, peer) = match &filter {
            Some(f) => (f.state.as_deref(), f.peer_device_id),
            None => (None, None),
        };
        let rows = engine.list_transfers(state, peer).map_err(engine_err)?;
        let json: Vec<serde_json::Value> = rows.iter().map(transfer_summary_json).collect();
        serde_json::to_string(&json).map_err(protocol_err)
    }

    pub fn list_inbox(&self) -> Result<String, FfiError> {
        let rows = self.engine()?.list_inbox().map_err(engine_err)?;
        let json: Vec<serde_json::Value> = rows.iter().map(inbox_entry_json).collect();
        serde_json::to_string(&json).map_err(protocol_err)
    }

    /// This device's own name and id, as JSON `{name, baseName, deviceId}`.
    /// The READ half of set_display_name: without it the UI can write a name
    /// and never show what the LAN actually resolved it to. `name` is the
    /// RESOLVED name (peers see it); `baseName` is the name the user typed and
    /// the one the settings file holds, which is what a rename box must show.
    pub fn self_profile(&self) -> Result<String, FfiError> {
        let engine = self.engine()?;
        let (name, device_id) = self.rt.block_on(engine.self_profile());
        // The RESOLVED name carries a LAN-collision prefix that a peer holding
        // the base name forces. That prefix is not a name the user typed, so
        // the payload also carries the BASE name: a Settings box prefills from
        // baseName, while peers keep showing name. See SelfProfile in
        // packages/core/src/engine/types.ts.
        let base_name = self.rt.block_on(engine.base_display_name());
        serde_json::to_string(&serde_json::json!({
            "name": name,
            "baseName": base_name,
            "deviceId": to_hex(&device_id),
        }))
        .map_err(protocol_err)
    }

    /// Rename this device. The engine re-resolves the name against the LAN and
    /// re-advertises, so this is NOT a local label edit: the next QR bundle
    /// carries the new name and peers browsing mDNS see it.
    pub fn set_display_name(&self, name: String) -> Result<(), FfiError> {
        let engine = self.engine()?;
        self.rt
            .block_on(engine.set_display_name(name))
            .map_err(engine_err)
    }

    pub fn set_presence(&self, state: String) -> Result<(), FfiError> {
        // Parse before the engine check so a bad state is a caller bug whether
        // or not the engine happens to be running -- same rule as cancel/retry.
        let state = parse_presence_state(&state)?;
        let engine = self.engine()?;
        self.rt
            .block_on(engine.set_presence(state))
            .map_err(engine_err)
    }

    pub fn local_port(&self) -> Result<u16, FfiError> {
        Ok(self.engine()?.local_addr().port())
    }

    pub fn shutdown(&self) -> Result<(), FfiError> {
        if let Some(engine) = self.engine.lock().unwrap().take() {
            self.rt.block_on(engine.shutdown()).map_err(engine_err)?;
        }
        Ok(())
    }

    /// The UDL-declared half of ffi_event_json. The event callback hands the
    /// platform an FfiEvent, not a string, so it calls this to get the JSON
    /// packages/core/src/engine/types.ts defines. Takes ev by value because
    /// that is the shape the generated scaffolding lowers to.
    pub fn ffi_event_json(&self, ev: FfiEvent) -> Result<String, FfiError> {
        ffi_event_json(&ev)
    }
}

fn device_ref(engine: &Engine, name: String) -> DeviceRef {
    DeviceRef {
        device_id: engine.identity().device_id(),
        name,
    }
}

/// Encode one engine signal as the JSON the native modules forward on the
/// `DaakEvent` channel. The key set below is the FROZEN TS DaakEvent shape
/// (spec 6.1); packages/core/src/engine/types.ts is the other end of it, and
/// Tasks 2/4/7 code against these exact names. The UDL callback carries an
/// FfiEvent, not a string, so this is a plain Rust function the platform
/// bindings call with the event they already received.
///
/// Exposed for the same reason to_ffi_event is: the whole mapping is testable
/// without a live engine or a bound socket.
pub fn ffi_event_json(ev: &FfiEvent) -> Result<String, FfiError> {
    // serde_json orders keys, so the tests compare key SETS.
    let json = match ev {
        FfiEvent::DeviceFound { data } => serde_json::json!({
            "type": "device.discovered",
            "device": {
                "deviceId": data.device_id,
                "name": data.name,
                "addr": data.addr,
                "online": data.online,
            },
        }),
        FfiEvent::DeviceState { data } => serde_json::json!({
            "type": "device.state",
            "deviceId": data.device_id,
            // TS carries a string here, never a bool, so JS switches on one shape.
            "state": if data.online { "online" } else { "offline" },
        }),
        FfiEvent::PairingSas { data } => serde_json::json!({
            "type": "pairing.sas",
            "peerDeviceId": data.peer_device_id,
            "sas": data.sas,
        }),
        FfiEvent::PairingDone { data } => serde_json::json!({
            "type": "pairing.done",
            "deviceId": data.device_id,
        }),
        FfiEvent::TransferProgress { data } => serde_json::json!({
            "type": "transfer.progress",
            "transferId": data.transfer_id,
            "bytesDone": data.bytes_done,
            "bytesTotal": data.bytes_total,
        }),
        FfiEvent::TransferItem { data } => serde_json::json!({
            "type": "transfer.item",
            "transferId": data.transfer_id,
            "itemIndex": data.item_index,
            "state": data.state,
            "destPath": data.dest_path,
        }),
        FfiEvent::TransferDone { data } => serde_json::json!({
            "type": "transfer.done",
            "transferId": data.transfer_id,
        }),
        FfiEvent::TransferFailed { data } => serde_json::json!({
            "type": "transfer.failed",
            "transferId": data.transfer_id,
            "error": data.error,
        }),
        // The engine hands over a JSON string and TS types it as an object, so
        // parse it rather than nesting a stringified blob. A payload the engine
        // could not have produced is a protocol error, not a silent null.
        FfiEvent::InboxReceived { data } => serde_json::json!({
            "type": "inbox.received",
            "payload": serde_json::from_str::<serde_json::Value>(&data.payload_json)
                .map_err(protocol_err)?,
        }),
        // The compatibility signal the Open Design "update required" screen
        // needs. Both numbers are REAL (the peer's mDNS TXT `v` and this
        // build's MANIFEST_VERSION), so the screen renders what the LAN
        // actually advertises instead of a hardcoded pair.
        FfiEvent::IncompatiblePeer { data } => serde_json::json!({
            "type": "peer.incompatible",
            "peerDeviceId": data.peer_device_id,
            "peerName": data.peer_name,
            "peerVersion": data.peer_version,
            "ourVersion": data.our_version,
        }),
    };
    serde_json::to_string(&json).map_err(protocol_err)
}

/// The JSON shape Tasks 2/3 read: {cbor, name, device_id}. A free function, not
/// a method, so the contract is testable without a live engine.
pub fn pairing_bundle_json(bundle: &PairingBundle) -> Result<String, FfiError> {
    let cbor = to_hex(&bundle.to_cbor().map_err(engine_err)?);
    let json = serde_json::json!({
        "cbor": cbor,
        "name": bundle.name,
        "device_id": to_hex(&bundle.identity.device_id),
    });
    serde_json::to_string(&json).map_err(protocol_err)
}

/// The SAS for an inbound pairing. accept_pairing_once() yields only the SAS
/// string, so the peer id is unknown and left empty rather than invented.
pub fn to_pairing_sas_event(sas: String) -> FfiEvent {
    FfiEvent::PairingSas {
        data: PairingSasEvent {
            peer_device_id: String::new(),
            sas,
        },
    }
}

/// Translate an engine event into the tagged union JS receives. Exposed so the
/// mapping can be tested without binding a socket.
pub fn to_ffi_event(ev: EngineEvent) -> FfiEvent {
    match ev {
        EngineEvent::DeviceFound(d) => FfiEvent::DeviceFound {
            data: DeviceFoundEvent {
                device_id: to_hex(&d.device_id),
                name: d.name,
                addr: d.addr.to_string(),
                online: true,
            },
        },
        EngineEvent::DeviceLost(id) => FfiEvent::DeviceState {
            data: DeviceStateEvent {
                device_id: to_hex(&id),
                online: false,
            },
        },
        EngineEvent::Presence { device_id, state } => FfiEvent::DeviceState {
            data: DeviceStateEvent {
                device_id: to_hex(&device_id),
                online: matches!(state, PresenceState::Online),
            },
        },
        EngineEvent::TransferProgress {
            transfer_id,
            bytes_done,
            bytes_total,
        } => FfiEvent::TransferProgress {
            data: ProgressEvent {
                transfer_id: to_hex(&transfer_id),
                bytes_done,
                bytes_total,
            },
        },
        // The ARM that was missing: FfiEvent::TransferItem and the
        // ffi_event_json mapping for it both existed, but nothing could produce
        // the event, so the union member was unreachable from JS.
        EngineEvent::TransferItem {
            transfer_id,
            item_index,
            state,
            dest_path,
        } => FfiEvent::TransferItem {
            data: TransferItemEvent {
                transfer_id: to_hex(&transfer_id),
                item_index,
                state,
                // TransferItemEvent.dest_path is a plain string, and the
                // daemon's IpcEvent::TransferItem is too, so None becomes the
                // empty string -- the same convention to_pairing_sas_event uses
                // for an unknown peer id. NOT null: DaemonClient reads this
                // with str(), which throws on a null.
                dest_path: dest_path.unwrap_or_default(),
            },
        },
        // C2: the arm that was missing, so pairing.done could never reach JS.
        EngineEvent::PairingDone { device_id } => FfiEvent::PairingDone {
            data: PairingDoneEvent {
                device_id: to_hex(&device_id),
            },
        },
        EngineEvent::TransferDone { transfer_id } => FfiEvent::TransferDone {
            data: DoneEvent {
                transfer_id: to_hex(&transfer_id),
            },
        },
        EngineEvent::TransferFailed { transfer_id, error } => FfiEvent::TransferFailed {
            data: FailedEvent {
                transfer_id: to_hex(&transfer_id),
                error,
            },
        },
        // C1: the arm that was missing, so the engine's inbox event could
        // never reach JS. inbox_entry_json is the EXISTING helper -- a second
        // hand-rolled copy of the saved_paths parse is how the two bridges
        // would drift on what a corrupt row means.
        EngineEvent::InboxReceived(row) => FfiEvent::InboxReceived {
            data: InboxReceivedEvent {
                // Cannot fail: an InboxEntry is hex strings, a u32, an i64 and
                // an array-or-null. `to_ffi_event` has no Result to fail into,
                // and inventing one would change a signature four callers use.
                payload_json: serde_json::to_string(&inbox_entry_json(&row))
                    .expect("an InboxEntry is strings, numbers and array-or-null"),
            },
        },
        EngineEvent::IncompatiblePeer {
            peer_device_id,
            peer_name,
            peer_version,
            our_version,
        } => FfiEvent::IncompatiblePeer {
            data: IncompatiblePeerEvent {
                peer_device_id: to_hex(&peer_device_id),
                peer_name,
                peer_version,
                our_version,
            },
        },
    }
}

uniffi::include_scaffolding!("daak");
