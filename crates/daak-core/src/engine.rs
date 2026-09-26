use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use bytes::Bytes;
use tokio::sync::{broadcast, mpsc, Mutex};

use crate::control::Hello;
use crate::crypto::identity::{verify_static_binding, Identity, IdentityPublic};
use crate::discovery::{
    Advertiser, Browser, PeerAnnounce, Presence, PresenceSocket, PresenceState,
};
use crate::error::{ensure_compatible, CoreError, Result};
use crate::framing::RecordType;
use crate::manifest::{Manifest, PayloadKind};
use crate::net::secure::{recv_secure_transfer, send_secure_transfer};
use crate::net::tcp;
use crate::net::Connection;
use crate::outbox::OutboxWorker;
use crate::pairing::{PairMode, PairingBundle};
use crate::staging::Staging;
use crate::store::inbox::InboxRow;
use crate::store::outbox::OutboxRow;
use crate::store::Db;

/// A rejected peer is a per-connection event; anything else is a listener fault.
fn accept_error_is_fatal(err: &crate::error::CoreError) -> bool {
    !matches!(err, crate::error::CoreError::Protocol(_))
}

pub struct EngineConfig {
    pub display_name: String,
    pub listen_addr: SocketAddr,
    pub out_dir: PathBuf,
    pub identity: Identity,
    pub db: Arc<Db>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceInfo {
    pub device_id: [u8; 16],
    pub name: String,
    pub addr: SocketAddr,
}

#[derive(Debug, Clone)]
pub enum EngineEvent {
    DeviceFound(DeviceInfo),
    DeviceLost([u8; 16]),
    Presence {
        device_id: [u8; 16],
        state: PresenceState,
    },
    TransferProgress {
        transfer_id: [u8; 16],
        bytes_done: u64,
        bytes_total: u64,
    },
    TransferDone {
        transfer_id: [u8; 16],
    },
    TransferFailed {
        transfer_id: [u8; 16],
        error: String,
    },
}

type PendingPairing = (PairingBundle, PairMode, Option<String>);

pub struct Engine {
    local_addr: SocketAddr,
    tx: broadcast::Sender<EngineEvent>,
    devices: Arc<Mutex<HashMap<[u8; 16], DeviceInfo>>>,
    advertiser: Advertiser,
    browser: Arc<Browser>,
    accept_task: tokio::task::JoinHandle<()>,
    discovery_task: tokio::task::JoinHandle<()>,
    presence_task: tokio::task::JoinHandle<()>,
    display_name: String,
    identity: Arc<Identity>,
    db: Arc<Db>,
    staging: Arc<Staging>,
    outbox: Arc<OutboxWorker>,
    pending_pairing: Arc<Mutex<Option<PendingPairing>>>,
    pending_code: Arc<Mutex<Option<String>>>,
    pairing_rx: Mutex<mpsc::Receiver<String>>,
}

impl Engine {
    pub async fn start(cfg: EngineConfig) -> Result<Self> {
        let (tx, _rx) = broadcast::channel(256);
        let devices = Arc::new(Mutex::new(HashMap::<[u8; 16], DeviceInfo>::new()));
        let mut session_id = [0u8; 16];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut session_id);

        let identity = Arc::new(cfg.identity);
        let device_id = identity.device_id();
        let db = cfg.db;
        let base_name = cfg.display_name.clone();
        let out_dir = cfg.out_dir.clone();

        // Crash recovery: a previous run may have died mid-send. Both resets run
        // BEFORE the accept loop and the outbox worker are spawned, so nothing
        // can claim a row that is about to be re-queued. A failed recovery is
        // logged, not fatal -- the engine must still start.
        match db.reset_inflight_outbox() {
            Ok(n) if n > 0 => tracing::warn!("requeued {n} in-flight outbox row(s)"),
            Ok(_) => {}
            Err(e) => tracing::warn!("outbox crash recovery failed: {e}"),
        }
        match db.reset_inflight_transfers() {
            Ok(n) if n > 0 => tracing::warn!("requeued {n} in-flight transfer(s)"),
            Ok(_) => {}
            Err(e) => tracing::warn!("transfer crash recovery failed: {e}"),
        }

        let (listener, local_addr) = tcp::bind(cfg.listen_addr).await?;
        let (advertiser, display_name) = Advertiser::start_resolving(
            &base_name,
            local_addr.port(),
            device_id,
            &mut rand::thread_rng(),
        )?;
        let browser = Arc::new(Browser::start()?);
        let presence = match PresenceSocket::bind().await {
            Ok(p) => {
                let p = Arc::new(p);
                // Best-effort: presence is an enhancement, not required for transfer.
                if let Err(e) = p
                    .announce(&Presence::new(
                        device_id,
                        session_id,
                        display_name.clone(),
                        PresenceState::Online,
                    ))
                    .await
                {
                    tracing::warn!("presence announce failed: {e}");
                }
                Some(p)
            }
            Err(e) => {
                tracing::warn!("presence socket unavailable: {e}");
                None
            }
        };

        let (pairing_tx, pairing_rx) = mpsc::channel(8);
        let pending_pairing = Arc::new(Mutex::new(None));
        let pending_code = Arc::new(Mutex::new(None));

        let staging = {
            let dir = out_dir.join("staging");
            std::fs::create_dir_all(&dir)?;
            Arc::new(Staging::new(dir))
        };
        let outbox = Arc::new({
            let drain_db = db.clone();
            let drain_identity = identity.clone();
            let drain_devices = devices.clone();
            let drain_staging = staging.clone();
            OutboxWorker::spawn(db.clone(), move |row| {
                let ctx = DrainCtx {
                    identity: drain_identity.clone(),
                    db: drain_db.clone(),
                    devices: drain_devices.clone(),
                    staging: drain_staging.clone(),
                };
                // ponytail: per-row drain tasks are intentionally untracked (a JoinSet
                // here costs more than it buys); a crash mid-drain is recovered at
                // startup by Task 7's reset_inflight_outbox().
                tokio::spawn(async move { drain_outbox_row(ctx, row).await });
            })
        });

        let accept_task = {
            let identity = identity.clone();
            let db = db.clone();
            let display_name = display_name.clone();
            let out_dir = out_dir.clone();
            let pending_pairing = pending_pairing.clone();
            let pending_code = pending_code.clone();
            let pairing_tx = pairing_tx.clone();
            let tx = tx.clone();
            tokio::spawn(async move {
                // JoinSet aborts any in-flight receivers when it is dropped, and the
                // accept task's locals are dropped when shutdown aborts this task, so
                // shutdown also stops in-flight handle_inbound calls.
                let mut set = tokio::task::JoinSet::new();
                loop {
                    let (mut conn, _peer) = match tcp::accept(&listener).await {
                        Ok(v) => v,
                        Err(e) => {
                            if accept_error_is_fatal(&e) {
                                tracing::warn!("accept failed, stopping listener: {e}");
                                break;
                            }
                            tracing::warn!("rejected connection: {e}");
                            continue;
                        }
                    };
                    let identity = identity.clone();
                    let db = db.clone();
                    let display_name = display_name.clone();
                    let out_dir = out_dir.clone();
                    let pending_pairing = pending_pairing.clone();
                    let pending_code = pending_code.clone();
                    let pairing_tx = pairing_tx.clone();
                    let tx = tx.clone();
                    set.spawn(async move {
                        if let Err(e) = Self::handle_inbound(
                            &identity,
                            &db,
                            &out_dir,
                            &display_name,
                            &pending_pairing,
                            &pending_code,
                            &pairing_tx,
                            &tx,
                            &mut conn,
                        )
                        .await
                        {
                            tracing::warn!("inbound connection failed: {e}");
                        }
                    });
                    while set.try_join_next().is_some() {}
                }
            })
        };

        let discovery_task = {
            let tx = tx.clone();
            let devices = devices.clone();
            let browser = browser.clone();
            let me = device_id;
            let outbox = outbox.clone();
            tokio::spawn(async move {
                while let Some(PeerAnnounce {
                    device_id,
                    name,
                    addr,
                    proto_version,
                    ..
                }) = browser.recv().await
                {
                    if device_id == me {
                        continue;
                    }
                    if let Err(e) = ensure_compatible(proto_version) {
                        tracing::warn!(
                            "peer {name} ({addr}) advertises incompatible proto version {proto_version}: {e}"
                        );
                        continue;
                    }
                    let info = DeviceInfo {
                        device_id,
                        name,
                        addr,
                    };
                    let is_new = {
                        let mut map = devices.lock().await;
                        map.insert(device_id, info.clone()).is_none()
                    };
                    if is_new {
                        let _ = tx.send(EngineEvent::DeviceFound(info));
                    }
                    // Wake on EVERY announce, not just the first: a peer that
                    // dropped off the map and reappeared is exactly the
                    // reconnect case the outbox drain exists for.
                    outbox.notify_peer_online(device_id);
                }
            })
        };

        let presence_task = {
            let tx = tx.clone();
            let me = device_id;
            let outbox = outbox.clone();
            match presence.clone() {
                Some(presence) => tokio::spawn(async move {
                    while let Ok((_from, p)) = presence.recv().await {
                        if p.device_id != me {
                            if p.state == PresenceState::Online {
                                outbox.notify_peer_online(p.device_id);
                            }
                            let _ = tx.send(EngineEvent::Presence {
                                device_id: p.device_id,
                                state: p.state,
                            });
                        }
                    }
                }),
                None => tokio::spawn(async {}),
            }
        };

        Ok(Self {
            local_addr,
            tx,
            devices,
            advertiser,
            browser,
            accept_task,
            discovery_task,
            presence_task,
            display_name,
            identity,
            db,
            staging,
            outbox,
            pending_pairing,
            pending_code,
            pairing_rx: Mutex::new(pairing_rx),
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub fn events(&self) -> broadcast::Receiver<EngineEvent> {
        self.tx.subscribe()
    }

    pub async fn devices(&self) -> Vec<DeviceInfo> {
        self.devices.lock().await.values().cloned().collect()
    }

    pub fn identity(&self) -> &Identity {
        self.identity.as_ref()
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    pub fn pairing_bundle(&self) -> PairingBundle {
        PairingBundle::new(self.identity.public(), self.display_name.clone())
    }

    pub async fn offer_pairing(
        &self,
        peer: PairingBundle,
        mode: PairMode,
        code: Option<String>,
    ) -> Result<()> {
        *self.pending_pairing.lock().await = Some((peer, mode, code));
        Ok(())
    }

    /// Offer a manual code for an inbound code-mode pairing. The peer's identity
    /// is learned in-band (authenticated by the SPAKE2-derived Noise prologue),
    /// so no QR bundle is required.
    pub async fn offer_code_pairing(&self, code: String) -> Result<()> {
        *self.pending_code.lock().await = Some(code);
        Ok(())
    }

    pub async fn accept_pairing_once(&self) -> Result<String> {
        let mut rx = self.pairing_rx.lock().await;
        rx.recv()
            .await
            .ok_or_else(|| CoreError::Protocol("pairing channel closed".into()))
    }

    pub async fn pair_with(
        &self,
        addr: SocketAddr,
        peer: PairingBundle,
    ) -> Result<(String, [u8; 16])> {
        let mut conn = tcp::dial(addr).await?;
        // R2: the inbound side reads a Hello before the Noise handshake, so the
        // initiator must send one first (pairing::pair would otherwise deadlock).
        conn.send(
            0,
            RecordType::Control,
            Bytes::from(
                Hello {
                    device_id: self.identity.device_id(),
                }
                .to_cbor()?,
            ),
        )
        .await?;
        let local = self.pairing_bundle();
        let (pairing, sas) = crate::pairing::pair(
            &mut conn,
            self.identity.as_ref(),
            &local,
            &peer,
            true,
            PairMode::Qr,
            None,
        )
        .await?;
        self.db.upsert_pairing(&pairing)?;
        Ok((sas, pairing.peer_device_id))
    }

    /// Manual-code pairing: no pre-scanned QR bundle. The initiator sends its
    /// identity in-band, reads the responder's identity, then runs the SPAKE2
    /// exchange inside `pairing::pair` with `PairMode::Code`.
    pub async fn pair_with_code(&self, addr: SocketAddr, code: &str) -> Result<(String, [u8; 16])> {
        let mut conn = tcp::dial(addr).await?;
        conn.send(
            0,
            RecordType::Control,
            Bytes::from(
                Hello {
                    device_id: self.identity.device_id(),
                }
                .to_cbor()?,
            ),
        )
        .await?;
        conn.send(
            0,
            RecordType::Control,
            Bytes::from(self.identity.public().to_cbor()?),
        )
        .await?;
        let peer_public = read_identity_public(&mut conn).await?;
        let name = hex::encode(peer_public.device_id);
        let peer = PairingBundle::new(peer_public, name);
        let local = self.pairing_bundle();
        let (pairing, sas) = crate::pairing::pair(
            &mut conn,
            self.identity.as_ref(),
            &local,
            &peer,
            true,
            PairMode::Code,
            Some(code),
        )
        .await?;
        self.db.upsert_pairing(&pairing)?;
        Ok((sas, pairing.peer_device_id))
    }

    pub async fn send_secure(
        &self,
        peer_device_id: [u8; 16],
        addr: SocketAddr,
        manifest: Manifest,
        paths: Vec<Option<PathBuf>>,
    ) -> Result<[u8; 16]> {
        send_secure_with(
            self.identity.as_ref(),
            &self.db,
            peer_device_id,
            addr,
            manifest,
            paths,
        )
        .await
    }

    /// Queue a send with no online peer present; the worker drains it on reconnect.
    pub async fn enqueue_outbox_send(
        &self,
        peer_device_id: [u8; 16],
        manifest: Manifest,
        paths: Vec<PathBuf>,
    ) -> Result<[u8; 16]> {
        let payload_id = manifest.payload_id;
        crate::outbox::enqueue(&self.db, &self.staging, &peer_device_id, &manifest, &paths)?;
        // Try immediately in case the peer is already online; harmless if not.
        self.outbox.notify_peer_online(peer_device_id);
        Ok(payload_id)
    }

    /// Cancel a queued or in-flight outbound transfer and discard its staged files.
    pub fn cancel(&self, transfer_id: [u8; 16]) -> Result<()> {
        cancel_with(&self.db, &self.staging, transfer_id)
    }

    /// Re-arm a failed or backed-off outbound transfer and poke the outbox worker.
    pub fn retry(&self, transfer_id: [u8; 16]) -> Result<()> {
        match retry_with(&self.db, transfer_id)? {
            Some(peer) => self.outbox.notify_peer_online(peer),
            // M-2: without this, a UI tapping Retry on an actively-sending row
            // gets Ok(()) and nothing at all happens.
            None => tracing::info!(
                "outbox retry refused: transfer {} is not in a re-armable state",
                hex::encode(transfer_id)
            ),
        }
        Ok(())
    }

    /// Called from the accept loop after a successful inbound transfer.
    fn record_inbox(db: &Db, manifest: &Manifest) -> Result<()> {
        let summary = match manifest.kind {
            PayloadKind::Text => manifest
                .items
                .first()
                .and_then(|i| i.text.clone())
                .unwrap_or_default(),
            _ => format!("{} file(s)", manifest.binary_items().count()),
        };
        db.add_inbox(&InboxRow {
            id: manifest.payload_id,
            transfer_id: manifest.payload_id,
            peer_device_id: manifest.sender.device_id,
            kind: format!("{:?}", manifest.kind).to_lowercase(),
            item_count: manifest.items.len() as u32,
            summary,
            received_at: crate::manifest::now_ms() as i64 / 1000,
            // Placeholder: the real paths are filled in when the receive path
            // reports them (later task).
            saved_paths: "[]".into(),
        })
    }

    /// Called by the accept loop for every inbound connection.
    #[allow(clippy::too_many_arguments)] // pending_pairing + pending_code are the two pairing slots
    pub(crate) async fn handle_inbound(
        identity: &Identity,
        db: &Db,
        out_dir: &Path,
        display_name: &str,
        pending_pairing: &Mutex<Option<PendingPairing>>,
        pending_code: &Mutex<Option<String>>,
        pairing_tx: &mpsc::Sender<String>,
        tx: &broadcast::Sender<EngineEvent>,
        conn: &mut Connection<tokio::net::TcpStream>,
    ) -> Result<()> {
        let hello = read_hello(conn).await?;
        let local = PairingBundle::new(identity.public(), display_name.to_string());
        // Manual-code pairing: no QR bundle was offered, so the peer's identity
        // arrives in-band and is authenticated by the SPAKE2-mixed prologue.
        if let Some(code) = pending_code.lock().await.take() {
            let peer_public = read_identity_public(conn).await?;
            if hello.device_id != peer_public.device_id {
                return Err(CoreError::Protocol(
                    "code pairing hello device mismatch".into(),
                ));
            }
            if !verify_static_binding(
                &peer_public.ed25519,
                &peer_public.x25519,
                &peer_public.static_sig,
            ) {
                return Err(CoreError::Protocol(
                    "code pairing peer identity binding failed".into(),
                ));
            }
            conn.send(
                0,
                RecordType::Control,
                Bytes::from(identity.public().to_cbor()?),
            )
            .await?;
            let name = hex::encode(peer_public.device_id);
            let expected = PairingBundle::new(peer_public, name);
            let (pairing, sas) = crate::pairing::pair(
                conn,
                identity,
                &local,
                &expected,
                false,
                PairMode::Code,
                Some(&code),
            )
            .await?;
            db.upsert_pairing(&pairing)?;
            let _ = pairing_tx.send(sas).await;
            return Ok(());
        }
        if let Some((expected, mode, code)) = pending_pairing.lock().await.take() {
            if hello.device_id != expected.identity.device_id {
                return Err(CoreError::Protocol("pairing hello device mismatch".into()));
            }
            let (pairing, sas) = crate::pairing::pair(
                conn,
                identity,
                &local,
                &expected,
                false,
                mode,
                code.as_deref(),
            )
            .await?;
            db.upsert_pairing(&pairing)?;
            let _ = pairing_tx.send(sas).await;
            return Ok(());
        }
        let pairing = db
            .get_pairing(&hello.device_id)?
            .ok_or_else(|| CoreError::Protocol("unpaired inbound connection".into()))?;
        let static_secret = zeroize::Zeroizing::new(identity.static_secret().to_bytes());
        match recv_secure_transfer(conn, &static_secret, &pairing.static_dh_pub, out_dir).await {
            Ok(manifest) => {
                let _ = tx.send(EngineEvent::TransferDone {
                    transfer_id: manifest.payload_id,
                });
                if let Err(e) = Self::record_inbox(db, &manifest) {
                    tracing::warn!("failed to record inbox row: {e}");
                }
                Ok(())
            }
            Err(e) => {
                let _ = tx.send(EngineEvent::TransferFailed {
                    transfer_id: [0u8; 16],
                    error: e.to_string(),
                });
                Err(e)
            }
        }
    }

    pub async fn shutdown(&self) -> Result<()> {
        self.accept_task.abort();
        self.discovery_task.abort();
        self.presence_task.abort();
        self.advertiser.stop();
        self.browser.stop();
        Ok(())
    }
}

async fn read_hello(conn: &mut Connection<tokio::net::TcpStream>) -> Result<Hello> {
    loop {
        match conn.recv().await? {
            Some(f) if f.kind == RecordType::Control => return Hello::from_cbor(&f.body),
            Some(_) => continue,
            None => return Err(CoreError::Protocol("closed before hello".into())),
        }
    }
}

/// Dial + Noise XX + send a manifest and its staged/binary paths.
/// Extracted from Engine::send_secure so the outbox drain can drive a send with
/// only Arc<Identity> + Arc<Db> (Task 11 refactors this to a session registry).
async fn send_secure_with(
    identity: &Identity,
    db: &Db,
    peer_device_id: [u8; 16],
    addr: SocketAddr,
    manifest: Manifest,
    paths: Vec<Option<PathBuf>>,
) -> Result<[u8; 16]> {
    let transfer_id = manifest.payload_id;
    let pairing = db
        .get_pairing(&peer_device_id)?
        .ok_or_else(|| CoreError::Protocol("peer is not paired".into()))?;
    let static_secret = zeroize::Zeroizing::new(identity.static_secret().to_bytes());
    let mut conn = tcp::dial(addr).await?;
    send_secure_transfer(
        &mut conn,
        &static_secret,
        &pairing.static_dh_pub,
        identity.device_id(),
        &manifest,
        &paths,
    )
    .await?;
    Ok(transfer_id)
}

/// What the outbox drain closure needs; the closure itself is a plain `Fn`, so
/// the per-row state is cloned into a task per row.
struct DrainCtx {
    identity: Arc<Identity>,
    db: Arc<Db>,
    devices: Arc<Mutex<HashMap<[u8; 16], DeviceInfo>>>,
    staging: Arc<Staging>,
}

/// Give up on a row after this many failed delivery attempts. 8 with the 4.3
/// backoff (15s doubling, 10min cap) spans roughly 35 minutes of retrying, which
/// covers a peer that is briefly away without pinning a staged file forever.
// ponytail: fixed cap, no adaptive heuristics; raise it only alongside a UI
// affordance for surfacing permanently-failed rows.
const MAX_DELIVERY_ATTEMPTS: u32 = 8;

/// R-T10-3: the UPDATEs in cancel/retry match zero rows for an unknown id, so
/// without this guard both would silently 'succeed' on garbage.
pub fn require_outbox(db: &Db, transfer_id: &[u8; 16]) -> Result<OutboxRow> {
    db.get_outbox(transfer_id)?.ok_or_else(|| {
        CoreError::Protocol(format!(
            "no outbox row for transfer {}",
            hex::encode(transfer_id)
        ))
    })
}

pub fn cancel_with(db: &Db, staging: &Staging, transfer_id: [u8; 16]) -> Result<()> {
    let row = require_outbox(db, &transfer_id)?;
    db.mark_outbox_terminal_failed(&transfer_id, "cancelled")?;
    // "canceled" is spec 4.2's transfers.state enum (ONE 'l'), not the
    // brief's "cancelled"; do not "fix" it back.
    db.set_transfer_state(&transfer_id, "canceled")?;
    staging.cleanup(&row.payload_id)
}

/// Returns the peer to notify, if the row was actually re-armed.
pub fn retry_with(db: &Db, transfer_id: [u8; 16]) -> Result<Option<[u8; 16]>> {
    let row = require_outbox(db, &transfer_id)?;
    if !db.retry_outbox_now(&transfer_id)? {
        return Ok(None);
    }
    // "queued" is spec 4.2's transfers.state for a re-armed send; "pending"
    // is outbox vocabulary and is not a member of that enum.
    db.set_transfer_state(&transfer_id, "queued")?;
    Ok(Some(row.peer_device_id))
}

/// Back off and retry, or give up. The one decision the retry path makes.
fn settle_failed_attempt(db: &Db, id: &[u8; 16], attempts: u32, jitter: u64) -> Result<()> {
    let now = crate::manifest::now_ms() as i64 / 1000;
    if attempts + 1 >= MAX_DELIVERY_ATTEMPTS {
        db.mark_outbox_terminal_failed(id, &format!("gave up after {} attempts", attempts + 1))
    } else {
        db.mark_outbox_failed(id, now, jitter)
    }
}

/// Rebuild a queued send from its row and push it, then settle the row state.
async fn drain_outbox_row(ctx: DrainCtx, row: OutboxRow) {
    let db = &ctx.db;
    let retry = |jitter: u64| {
        // R-T10-5: cap the retries. Without this a permanently unreachable peer
        // (or a permanently bad file) retries forever and never leaves 'failed'.
        let _ = settle_failed_attempt(db, &row.id, row.attempts, jitter);
    };

    // R-D: an unknown peer is a failure, not a panic -- the row goes back to
    // pending with backoff and is retried on the next tick or reconnect.
    let Some(addr) = ctx
        .devices
        .lock()
        .await
        .get(&row.peer_device_id)
        .map(|d| d.addr)
    else {
        tracing::warn!(
            "outbox drain: peer {} not discovered, re-queueing",
            hex::encode(row.peer_device_id)
        );
        retry(0);
        return;
    };
    let manifest = match Manifest::from_cbor(&row.manifest) {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!("outbox drain: row {} undecodable: {e}", hex::encode(row.id));
            // An undecodable manifest is permanent: retrying re-reads the same
            // bytes forever. Terminal instead of burning the attempt budget.
            let _ = db.mark_outbox_terminal_failed(&row.id, &format!("undecodable manifest: {e}"));
            return;
        }
    };
    // `paths` is indexed by item index (sender.rs looks it up with
    // `item.index as usize`), not by position among the items.
    let mut paths: Vec<Option<PathBuf>> = vec![None; manifest.items.len()];
    for item in &manifest.items {
        if item.is_binary() {
            paths[item.index as usize] = Some(
                ctx.staging
                    .staged_path(&row.payload_id, item.name.as_deref().unwrap_or_default()),
            );
        }
    }
    match send_secure_with(
        ctx.identity.as_ref(),
        db,
        row.peer_device_id,
        addr,
        manifest,
        paths,
    )
    .await
    {
        // R-C: send_transfer already read the peer's Ack and returns Ok ONLY on
        // complete && hash_ok (Err on mismatch/close), so Ok(()) IS the ack.
        Ok(_) => {
            let _ = db.mark_outbox_awaiting_ack(&row.id);
            let _ = db.mark_outbox_done(&row.id);
        }
        Err(e) => {
            tracing::warn!(
                "outbox drain: send to {} failed: {e}",
                hex::encode(row.peer_device_id)
            );
            retry(rand::random::<u64>() % 10);
        }
    }
}

async fn read_identity_public(
    conn: &mut Connection<tokio::net::TcpStream>,
) -> Result<IdentityPublic> {
    match conn.recv().await? {
        Some(f) if f.kind == RecordType::Control => IdentityPublic::from_cbor(&f.body),
        Some(_) => Err(CoreError::Protocol(
            "expected identity public, got non-control frame".into(),
        )),
        None => Err(CoreError::Protocol("closed before identity public".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accept_error_classifies_protocol_rejection_as_non_fatal() {
        assert!(!accept_error_is_fatal(&crate::error::CoreError::Protocol(
            "x".into()
        )));
        assert!(accept_error_is_fatal(&crate::error::CoreError::Io(
            std::io::Error::other("boom")
        )));
    }

    #[test]
    fn retries_back_off_until_the_cap_then_goes_terminal() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.enqueue_outbox(&OutboxRow {
            id: [1u8; 16],
            payload_id: [2u8; 16],
            peer_device_id: [3u8; 16],
            manifest: vec![],
            total_bytes: 0,
            attempts: 0,
            next_attempt_at: 0,
            // A drain always settles the row it claimed, so the fixture starts
            // 'pending' and the test claims it (I-2 guards the 'sending' state).
            state: "pending".into(),
            created_at: 0,
            updated_at: 0,
        })
        .unwrap();

        // Every attempt below the cap goes back to pending with a bumped count.
        for want in 1..MAX_DELIVERY_ATTEMPTS {
            assert!(
                db.mark_outbox_sending(&[1u8; 16]).unwrap(),
                "the drain re-claims the row it just re-pended"
            );
            settle_failed_attempt(&db, &[1u8; 16], want - 1, 0).unwrap();
            let row = db.get_outbox(&[1u8; 16]).unwrap().unwrap();
            assert_eq!(row.state, "pending", "attempt {want} must back off");
            assert_eq!(row.attempts, want);
        }

        // The last one is terminal: a row that never leaves 'failed' is the bug.
        db.mark_outbox_sending(&[1u8; 16]).unwrap();
        settle_failed_attempt(&db, &[1u8; 16], MAX_DELIVERY_ATTEMPTS - 1, 0).unwrap();
        assert_eq!(db.get_outbox(&[1u8; 16]).unwrap().unwrap().state, "failed");
    }
}
