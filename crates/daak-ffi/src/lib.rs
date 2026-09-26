//! UniFFI surface over daak-core.
//!
//! The UDL in daak.udl owns the ABI: every type named there must also be
//! declared here under the same name, and uniffi::include_scaffolding! attaches
//! the FFI lowering to those declarations.
// uniffi 0.28's UDL template emits a doc comment followed by blank lines, which
// trips clippy::empty_line_after_doc_comments. The file is generated, so the
// lint is allowed crate-wide rather than patched upstream.
#![allow(clippy::empty_line_after_doc_comments)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::SecretStore;
use daak_core::discovery::PresenceState;
use daak_core::engine::{Engine, EngineConfig, EngineEvent};
use daak_core::manifest::{DeviceRef, Item, Manifest, CHUNK_SIZE_DEFAULT};
use daak_core::pairing::PairingBundle;
use daak_core::store::Db;
use daak_core::CoreError;

// ---- Types named by daak.udl. include_scaffolding! lowers these; the shapes
// ---- here must stay in step with the UDL or the FFI symbols do not match.

#[derive(Debug, thiserror::Error)]
pub enum FfiError {
    #[error("{0}")]
    Engine(String),
    #[error("{0}")]
    Protocol(String),
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

/// One tagged union for every engine signal, so the JS callback has a single
/// shape to switch on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FfiEvent {
    DeviceFound { data: DeviceFoundEvent },
    DeviceState { data: DeviceStateEvent },
    PairingSas { data: PairingSasEvent },
    TransferProgress { data: ProgressEvent },
    TransferItem { data: TransferItemEvent },
    TransferDone { data: DoneEvent },
    TransferFailed { data: FailedEvent },
    TransferQueued { data: DoneEvent },
    InboxReceived { data: InboxReceivedEvent },
}

/// The one method JS must implement to receive engine signals. The generated
/// scaffolding supplies the foreign (vtable) side. Send + Sync are declared here
/// rather than added at the use site: the event task moves the sink onto a
/// multithreaded runtime, so the sink has to satisfy both.
pub trait EventSink: Send + Sync {
    fn on_event(&self, event: FfiEvent);
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

/// Where the engine identity is loaded from: one 0600 file per key under
/// <data_dir>/keys, so the device id and static key survive a restart and
/// pairing does not silently break on relaunch.
// The 0600 below comes from OpenOptions::mode, which applies only when the
// file is CREATED; a later write to an existing key file leaves its mode as
// it already was. It is also Unix-only -- mode has no meaning on Windows.
/// ponytail: plaintext files guarded only by mode bits. The upgrade path is the
/// OS-keystore TurboModule (iOS Keychain / Android Keystore / DPAPI), Phase 5.
pub struct FileKeyStore {
    dir: PathBuf,
}

impl FileKeyStore {
    pub fn new(dir: impl Into<PathBuf>) -> Result<Self, FfiError> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir).map_err(engine_err)?;
        Ok(Self { dir })
    }
}

impl SecretStore for FileKeyStore {
    fn get(&self, key: &str) -> daak_core::Result<Option<Vec<u8>>> {
        match std::fs::read(self.dir.join(key)) {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn set(&self, key: &str, value: &[u8]) -> daak_core::Result<()> {
        use std::io::Write;
        let mut opts = std::fs::OpenOptions::new();
        opts.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(self.dir.join(key))?;
        f.write_all(value)?;
        Ok(())
    }

    fn delete(&self, key: &str) -> daak_core::Result<()> {
        match std::fs::remove_file(self.dir.join(key)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

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
        DaakEngine {
            rt: tokio::runtime::Runtime::new().expect("tokio runtime"),
            engine: Mutex::new(None),
            sink: Arc::from(sink),
            pairing_sas: Mutex::new(None),
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
        let store = FileKeyStore::new(dir.join("keys"))?;
        let db = Db::open(&dir.join("daak.db")).map_err(engine_err)?;
        db.migrate().map_err(engine_err)?;
        let cfg = EngineConfig {
            display_name,
            listen_addr: format!("0.0.0.0:{listen_port}")
                .parse()
                .map_err(protocol_err)?,
            out_dir: dir.join("downloads"),
            identity: import_from_store(&store).map_err(engine_err)?,
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
        let bundle = self.engine()?.pairing_bundle();
        pairing_bundle_json(&bundle)
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
        manifest.sender = device_ref(&engine);
        let id = self
            .rt
            .block_on(engine.enqueue_outbox_send(parse_id(&peer_id)?, manifest, vec![]))
            .map_err(engine_err)?;
        Ok(to_hex(&id))
    }

    pub fn send_files(&self, peer_id: String, paths: Vec<String>) -> Result<String, FfiError> {
        let engine = self.engine()?;
        let mut items = Vec::with_capacity(paths.len());
        for (i, p) in paths.iter().enumerate() {
            items.push(
                Item::from_file(i as u32, Path::new(p), CHUNK_SIZE_DEFAULT).map_err(engine_err)?,
            );
        }
        let manifest = Manifest::batch(device_ref(&engine), items).map_err(engine_err)?;
        let id = self
            .rt
            .block_on(engine.enqueue_outbox_send(
                parse_id(&peer_id)?,
                manifest,
                paths.into_iter().map(PathBuf::from).collect(),
            ))
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

    pub fn local_port(&self) -> Result<u16, FfiError> {
        Ok(self.engine()?.local_addr().port())
    }

    pub fn shutdown(&self) -> Result<(), FfiError> {
        if let Some(engine) = self.engine.lock().unwrap().take() {
            self.rt.block_on(engine.shutdown()).map_err(engine_err)?;
        }
        Ok(())
    }
}

fn device_ref(engine: &Engine) -> DeviceRef {
    DeviceRef {
        device_id: engine.identity().device_id(),
        name: engine.display_name().to_string(),
    }
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
    }
}

uniffi::include_scaffolding!("daak");
