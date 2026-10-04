use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use bytes::Bytes;
use tokio::sync::{broadcast, mpsc, Mutex};

use crate::control::Hello;
use crate::crypto::identity::{verify_static_binding, Identity, IdentityPublic};
use crate::discovery::{
    advertise_ip, Advertiser, Browser, PeerAnnounce, Presence, PresenceSocket, PresenceState,
};
use crate::error::{ensure_compatible, CoreError, Result};
use crate::framing::RecordType;
use crate::manifest::{Manifest, PayloadKind};
use crate::net::secure::recv_secure_transfer;
use crate::net::tcp;
use crate::net::Connection;
use crate::outbox::OutboxWorker;
use crate::pairing::{PairMode, PairingBundle};
use crate::session::{BoxConnect, BoxFutureConn, SessionRegistry, SharedSessions, TcpConn};
use crate::staging::Staging;
use crate::store::inbox::InboxRow;
use crate::store::outbox::OutboxRow;
use crate::store::pairings::Pairing;
use crate::store::transfers::TransferRow;
use crate::store::Db;
use crate::transfer::Quarantine;

/// A rejected peer is a per-connection event; anything else is a listener fault.
fn accept_error_is_fatal(err: &crate::error::CoreError) -> bool {
    !matches!(err, crate::error::CoreError::Protocol(_))
}

/// A JSON array of strings, for the one column that holds JSON: inbox
/// saved_paths, which both bridges parse with serde_json on the way out.
///
/// daak-core has no JSON dependency and does not get one for this: the value is
/// an array of OS paths, so the only characters needing escape are the quote,
/// the backslash and the C0 controls. A control byte is emitted as \u00XX
/// rather than passed through, because serde_json correctly rejects a raw
/// control inside a string and a row that will not parse bridges as `null`.
fn json_string_array(items: &[String]) -> String {
    let mut out = String::from("[");
    for (i, s) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('"');
        for c in s.chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\u{8}' => out.push_str("\\b"),
                '\u{c}' => out.push_str("\\f"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out.push('"');
    }
    out.push(']');
    out
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
    /// One inbound ITEM settled. Emitted from receive_transfer's per-item loop
    /// right after that item's row is persisted, so an event never names a row
    /// that does not exist.
    ///
    /// Exactly the four fields BOTH bridges already carry: IpcEvent::TransferItem
    /// (crates/daak-ipc/src/lib.rs:181-186) and FfiEvent's TransferItemEvent
    /// (crates/daak-ffi/src/lib.rs:73-78) use the same four. A name field
    /// exists on ItemRow and would be free here, but adding it to only one
    /// bridge is exactly the per-bridge drift the Phase 4 rulings forbid -- the
    /// desktop and mobile views of one logical event must not differ. Whoever
    /// wires the name adds it to BOTH sides in one change.
    ///
    /// dest_path is None for a non-binary item, which is never materialised: a
    /// path there would name a file that can never exist.
    TransferItem {
        transfer_id: [u8; 16],
        item_index: u32,
        state: String,
        dest_path: Option<String>,
    },
    TransferDone {
        transfer_id: [u8; 16],
    },
    TransferFailed {
        transfer_id: [u8; 16],
        error: String,
    },
    /// A peer on this LAN announced a protocol version this build refuses
    /// (ensure_compatible), so it is dropped from the device map and never
    /// becomes a sendable peer. It used to be a `tracing::warn!` and nothing
    /// else, which made the Open Design "update required" screen
    /// unimplementable without inventing version numbers: the UI had no way to
    /// learn a peer existed and was refused.
    ///
    /// `peer_version` and `our_version` are the two real numbers from
    /// PeerAnnounce.proto_version and manifest::MANIFEST_VERSION. `peer_name`
    /// and `peer_device_id` name WHO is out of step, so the screen can say
    /// "Kitchen Tablet needs a newer Daak" instead of "something is wrong".
    ///
    /// Emitted once per announcing peer per announce interval, not latched:
    /// the browser re-announces on a timer, and a UI that shows a stale
    /// "update needed" after the peer updated is worse than one that shows
    /// the current truth. A peer that has gone quiet simply stops being
    /// announced, so the row goes away with the device.
    IncompatiblePeer {
        peer_device_id: [u8; 16],
        peer_name: String,
        peer_version: u16,
        our_version: u16,
    },
    /// An inbound payload was received AND its inbox_history row was written.
    /// Carries the whole row, not the manifest: kind, summary, itemCount,
    /// receivedAt and savedPaths are what the UI needs, and the two bridges
    /// already have inbox_entry_json() for it. Emitted only when the row was
    /// actually persisted -- an event for a row that does not exist is a lie.
    InboxReceived(InboxRow),
    /// An inbound pairing's row was persisted by `db.upsert_pairing`. Emitted
    /// ONLY after that call returns Ok: an event for a pairing that is not in
    /// the database is a lie, exactly as for InboxReceived. Carries the peer's
    /// device id and nothing else -- the UI's whole use of it is refreshing the
    /// peer list, which the joiner needs on the same signal.
    PairingDone {
        device_id: [u8; 16],
    },
}

/// What the accept slot is armed WITH.
///
/// `Expected` is the QR re-arm path: the host (or any surface) already holds
/// the peer's bundle, so the inbound hello's device id is checked against it
/// and the Noise prologue is built from it. Unchanged, and still the default.
///
/// `Open` is spec 3.3 Mode A. The QR flow is ASYMMETRIC -- only the JOINER
/// scans, so only the joiner ever holds the HOST's bundle, and the sanctioned
/// flow never gives the host the joiner's bundle. Requiring one made host-side
/// pairing unreachable by a real user, which is the C2 blocker. `Open` accepts
/// the first inbound pairing with no pre-known peer: the peer sends its
/// identity in-band, the same as the manual-code path, and it is authenticated
/// by the Noise XX handshake plus the key confirmation (spec 3.5).
///
/// TRUST SURFACE: on the open arm the host can no longer pre-empt an identity
/// substitution -- there is nothing to compare the in-band identity against.
/// What still holds: `pair()` runs `verify_static_binding` on the received
/// identity (so a forged `device_id` cannot claim a key it cannot sign for), the
/// Noise XX handshake authenticates the peer to THAT identity, spec 3.5 key
/// confirmation proves the peer holds the same session, and the SAS is derived
/// from a handshake hash bound to both static keys. What the user gains is the
/// SAS comparison; a user who does not compare it has accepted the peer's
/// self-declared identity. The bundle-matched path is the stronger one and is
/// preserved exactly.
///
/// Note the engine ALSO calls `verify_static_binding` on the in-band identity
/// before handing it to `pair`. That copy is DELIBERATELY REDUNDANT -- `pair`
/// performs the identical check as its first action -- and is kept only as
/// defence in depth at a trust boundary. It is not what makes the open arm
/// safe; removing it changes nothing, which is exactly why it is not mistaken
/// for the load-bearing check.
#[derive(Debug, Clone, PartialEq, Eq)]
enum PendingArm {
    Expected(PairingBundle),
    Open,
}

/// `PendingArm` is `Clone` (the bundle is owned data) precisely so the accept
/// path can INSPECT the arm without consuming it. See `handle_inbound`.
#[derive(Debug, Clone)]
pub(crate) struct PendingPairing {
    arm: PendingArm,
    mode: PairMode,
    code: Option<String>,
}

pub struct Engine {
    local_addr: SocketAddr,
    tx: broadcast::Sender<EngineEvent>,
    devices: Arc<Mutex<HashMap<[u8; 16], DeviceInfo>>>,
    browser: Arc<Browser>,
    accept_task: tokio::task::JoinHandle<()>,
    discovery_task: tokio::task::JoinHandle<()>,
    presence_task: tokio::task::JoinHandle<()>,
    /// The RESOLVED name (base name plus any collision suffix). It changes at
    /// runtime -- set_display_name re-resolves and re-advertises -- so it and
    /// the mDNS Advertiser built from it are behind one lock, swapped together
    /// so a reader can never see a new name next to an advertiser still
    /// publishing the old one. Presence announcements carry the name too, so
    /// they are re-sent on a rename rather than left stale.
    profile: Arc<Mutex<Profile>>,
    identity: Arc<Identity>,
    db: Arc<Db>,
    staging: Arc<Staging>,
    /// The receive root the accept loop materialises inbound files under. Held
    /// here, not just in the accept closure, because the quarantine operations
    /// (`recheck_quarantined_item` / `delete_quarantined_item`) have to reach
    /// the SAME tree the receiver quarantined into -- `<out_dir>/quarantine` is
    /// derived from it, so a second copy of out_dir could name a different one.
    out_dir: PathBuf,
    outbox: Arc<OutboxWorker>,
    /// R-T11-3/R-T11-11: behind a Mutex because the Engine is only ever held by
    /// &self, and the per-row outbox drain drives sends through the same Arc.
    sessions: SharedSessions,
    pending_pairing: Arc<Mutex<Option<PendingPairing>>>,
    pending_code: Arc<Mutex<Option<String>>>,
    pairing_rx: Mutex<mpsc::Receiver<String>>,
}

pub(crate) struct Profile {
    /// The name the user last asked for, before collision resolution. A rename
    /// re-resolves from THIS, not from the current resolved name, or a device
    /// that booted as "daak-2" could never go back to "daak".
    base_name: String,
    resolved_name: String,
    advertiser: Advertiser,
    presence: Option<Arc<PresenceSocket>>,
    session_id: [u8; 16],
    presence_state: PresenceState,
}

/// Everything the "Held back" screen shows about one quarantined item.
///
/// A REPORT and not a verdict. The prototype's screen pairs "Fingerprint it
/// should have" with "Fingerprint it has" and leaves the comparison to the
/// person reading it, so both travel together and neither is decided here.
/// They are the REAL hashes: `expected` is the one the sender attested in the
/// manifest, `actual` was computed from the bytes on this disk just now.
///
/// `name`, `size` and `received_at` are Option/`None`-able because they are
/// read from what was actually persisted. `sender_name` is the peer's PAIRED
/// label -- the only name this device ever durably recorded for it. `None`
/// means "not recorded", and the UI must not fill it in: a device id prefix
/// dressed up as a display name is a fabricated fact on a security screen.
///
/// `sender_device_id` is present precisely because `sender_name` can be `None`:
/// it is the REAL id from the transfer row, so the UI can show an honest
/// "Device aabbccdd" when no paired label exists. That is an identifier, not an
/// invented name, and it is why the fallback is allowed where a name is not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuarantineReport {
    pub transfer_id: [u8; 16],
    pub item_index: u32,
    pub name: Option<String>,
    pub size: Option<u64>,
    pub sender_name: Option<String>,
    /// The sending peer's device id, from the transfer row. `None` only when
    /// the transfer row itself is gone, which `require_item` makes impossible.
    pub sender_device_id: Option<[u8; 16]>,
    pub received_at: Option<i64>,
    pub expected: [u8; 32],
    pub actual: [u8; 32],
    /// Where the bytes actually are, derived from out_dir rather than read back
    /// from the row, so a corrupt dest_path cannot redirect a reader.
    pub held_path: String,
}

impl Engine {
    /// The ONE place a pairing becomes real, on all four paths (the joiner's
    /// `pair_with` / `pair_with_code` and the host's QR / code branches in
    /// `handle_inbound`). The row is committed and THEN the event goes out, so
    /// no subscriber can read a pairing the database does not have -- the same
    /// ordering `record_inbox` + `InboxReceived` follows. A single function is
    /// the point: four call sites each emitting after their own upsert is four
    /// chances to forget one.
    fn commit_pairing(
        db: &Db,
        pairing: &Pairing,
        tx: &broadcast::Sender<EngineEvent>,
    ) -> Result<()> {
        db.upsert_pairing(pairing)?;
        let _ = tx.send(EngineEvent::PairingDone {
            device_id: pairing.peer_device_id,
        });
        Ok(())
    }

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
        let (advertiser, display_name) = Advertiser::start_resolving_on(
            &base_name,
            local_addr.port(),
            device_id,
            &mut rand::thread_rng(),
            // Every shipped entry point binds 0.0.0.0, and tcp::bind reports
            // that wildcard back. Publishing it verbatim with addr_auto off
            // writes 0.0.0.0:<port> into the A record, which a browsing peer
            // resolves and then refuses as non-local. advertise_ip maps it back
            // to None so the auto form is used instead.
            advertise_ip(local_addr.ip()),
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
        // The accept loop needs the RESOLVED name to answer a pairing, and a
        // rename takes this same lock, so hand the loop a shared handle rather
        // than the frozen startup copy. Built HERE (before the accept task) so
        // the loop can hold it; the advertiser and the presence socket move
        // into it and out of the locals below.
        let presence_rx = presence.clone();
        let profile = Arc::new(Mutex::new(Profile {
            base_name,
            resolved_name: display_name.clone(),
            advertiser,
            presence,
            session_id,
            presence_state: PresenceState::Online,
        }));
        // R-T11-3: the registry owns dialling. The connect closure resolves the
        // peer's SocketAddr from the device map and runs the ONE initiator
        // handshake (net::secure::open_secure) -- no second handshake anywhere.
        let sessions: SharedSessions =
            {
                let db = db.clone();
                let identity = identity.clone();
                let devices = devices.clone();
                let connect: BoxConnect =
                    Box::new(move |peer: [u8; 16]| {
                        let db = db.clone();
                        let identity = identity.clone();
                        let devices = devices.clone();
                        Box::pin(async move {
                            let addr = devices.lock().await.get(&peer).map(|d| d.addr).ok_or_else(
                                || {
                                    CoreError::Protocol(format!(
                                        "peer {} is not discovered",
                                        hex::encode(peer)
                                    ))
                                },
                            )?;
                            let pairing = db
                                .get_pairing(&peer)?
                                .ok_or_else(|| CoreError::Protocol("peer is not paired".into()))?;
                            let secret =
                                zeroize::Zeroizing::new(identity.static_secret().to_bytes());
                            let conn = tcp::dial(addr).await?;
                            crate::net::secure::open_secure(
                                conn,
                                &secret,
                                &pairing.static_dh_pub,
                                identity.device_id(),
                            )
                            .await
                        }) as BoxFutureConn
                    });
                Arc::new(Mutex::new(SessionRegistry::new(
                    SESSION_IDLE_TIMEOUT,
                    connect,
                )))
            };
        let outbox = Arc::new({
            let drain_db = db.clone();
            let drain_staging = staging.clone();
            let drain_sessions = sessions.clone();
            OutboxWorker::spawn(db.clone(), move |row| {
                let ctx = DrainCtx {
                    db: drain_db.clone(),
                    staging: drain_staging.clone(),
                    sessions: drain_sessions.clone(),
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
            let profile = profile.clone();
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
                    let out_dir = out_dir.clone();
                    let pending_pairing = pending_pairing.clone();
                    let pending_code = pending_code.clone();
                    let pairing_tx = pairing_tx.clone();
                    let tx = tx.clone();
                    let profile = profile.clone();
                    set.spawn(async move {
                        if let Err(e) = Self::handle_inbound(
                            &identity,
                            &db,
                            &out_dir,
                            &profile,
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
                        // The warn! above is for the operator; this is for the
                        // UI. Without it the peer is silently absent from the
                        // device list and the user sees an empty screen with
                        // no explanation, which is indistinguishable from
                        // "nobody is home".
                        let _ = tx.send(EngineEvent::IncompatiblePeer {
                            peer_device_id: device_id,
                            peer_name: name.clone(),
                            peer_version: proto_version,
                            our_version: crate::manifest::MANIFEST_VERSION,
                        });
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
            match presence_rx {
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
            profile,
            browser,
            accept_task,
            discovery_task,
            presence_task,
            identity,
            db,
            staging,
            out_dir,
            outbox,
            sessions,
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

    /// R-T11-3: the registry resolves a peer's address from the device map, so a
    /// caller that was GIVEN an address (the CLI's `send --to`) must seed it.
    /// Discovery inserts the same entry; this is the one-shot path.
    ///
    /// An address the caller supplied WINS over a discovery-inserted one, and
    /// what the code actually guarantees is this:
    ///
    /// * the `addr` on the map is always the caller's, for an existing entry as
    ///   well as a new one -- so `send_secure` never dials an address the caller
    ///   did not name;
    /// * the `name` is NEVER taken from the caller for an existing entry,
    ///   because the caller has no better one to offer (daak-cli passes the hex
    ///   device id) and the UI is already showing the discovered name.
    ///
    /// It does NOT guarantee the map matches what a peer last advertised over
    /// mDNS: this path is authoritative and can differ from discovery, by
    /// design. Discovery re-announces on a timer, so a peer that later advertises
    /// a different address overwrites this again -- which is why re-addressing
    /// here has to be VISIBLE (below) rather than silent.
    ///
    /// The emitted `DeviceFound` is for the CHANGE case only, and only on an
    /// address that really changed:
    ///
    /// * a fresh insert stays SILENT, unchanged from before this method ever
    ///   mutated anything. Discovery is what announces a newly seen peer, and a
    ///   caller seeding one was told about it already -- emitting here would
    ///   double-report every seeded peer and invent a "discovery" for a peer
    ///   that discovery has not seen;
    /// * a changed address EMITS, because the discovery path emits on insert
    ///   only (`is_new`), so a re-address would otherwise leave the UI holding
    ///   an address nothing listens on, silently, until the next announce.
    ///   Both bridges already carry a full `DeviceInfo` on `DeviceFound` and
    ///   the UI store merges one by device id, so a re-address needs no new wire
    ///   variant and no field.
    ///
    /// The devices lock is held only across the map mutation and dropped before
    /// the send, so a subscriber that is slow to drain its channel cannot stall
    /// the outbox wake-up below.
    pub async fn note_peer(&self, peer: [u8; 16], name: &str, addr: SocketAddr) {
        let mut devices = self.devices.lock().await;
        // None unless an EXISTING entry changed address. `and_modify` cannot
        // report "changed" vs "left alone" without a captured flag, so the
        // entry is matched directly and the old DeviceInfo is read back out of
        // it -- one value, not two sources of truth.
        let re_addressed = match devices.entry(peer) {
            std::collections::hash_map::Entry::Occupied(mut e) => {
                if e.get().addr == addr {
                    None
                } else {
                    e.get_mut().addr = addr;
                    Some(e.get().clone())
                }
            }
            std::collections::hash_map::Entry::Vacant(e) => {
                e.insert(DeviceInfo {
                    device_id: peer,
                    name: name.to_string(),
                    addr,
                });
                None
            }
        };
        drop(devices);
        if let Some(info) = re_addressed {
            let _ = self.tx.send(EngineEvent::DeviceFound(info));
        }
        // Seeding an address means the peer is reachable NOW, so wake the drain
        // the same way the discovery and presence handlers do. Without this the
        // one-shot path (daak-cli `send --to`) would leave a queued row waiting
        // for the 5s poll tick and its backoff, and the reconnect this method
        // exists to enable would land up to one backoff late.
        self.outbox.notify_peer_online(peer);
    }

    pub fn identity(&self) -> &Identity {
        self.identity.as_ref()
    }

    pub async fn display_name(&self) -> String {
        self.profile.lock().await.resolved_name.clone()
    }

    /// This device's own identity and advertised name.
    ///
    /// `set_display_name` existed with no reader, so a UI could WRITE a name
    /// and never show what the device was actually called -- Settings opened on
    /// an empty box, and first-run onboarding had nothing real to prefill.
    /// One call answers both: the RESOLVED name (with any LAN-collision
    /// suffix, which is the name peers see and the one a user must be able to
    /// change) plus the device id, as hex like every other id on this API.
    pub async fn self_profile(&self) -> (String, [u8; 16]) {
        (
            self.profile.lock().await.resolved_name.clone(),
            self.identity.device_id(),
        )
    }

    /// Every transfer row, newest first, narrowed by an optional state and an
    /// optional peer. This is the ONLY reader listTransfers() needs: both the
    /// FFI and daakd go through the Engine so the two deployments cannot
    /// disagree on what the filter means or on the ordering.
    pub fn list_transfers(
        &self,
        state: Option<&str>,
        peer_device_id: Option<[u8; 16]>,
    ) -> Result<Vec<TransferRow>> {
        self.db.list_transfers(state, peer_device_id.as_ref())
    }

    /// Every received payload, newest first.
    pub fn list_inbox(&self) -> Result<Vec<InboxRow>> {
        self.db.list_inbox()
    }

    /// Rename this device and re-advertise. The new base name goes through the
    /// SAME collision resolution startup uses, so two devices renamed "phone"
    /// on one LAN do not end up advertising one name -- and the resolved name
    /// (with any suffix) is what presence and the pairing bundle report.
    ///
    /// A resolution that fails leaves the OLD advertisement running and
    /// returns the error: half-renamed (new name remembered, old mDNS record
    /// still up) is the one state neither deployment can represent.
    pub async fn set_display_name(&self, name: String) -> Result<()> {
        if name.trim().is_empty() {
            return Err(CoreError::Protocol("display name must not be empty".into()));
        }
        // Resolve OUTSIDE the lock. Advertiser::start_resolving does a std
        // recv_timeout on a background thread (up to ~1.3s), and the announce
        // below is a socket write; holding the profile mutex across both
        // stalled every display_name() / pairing_bundle() reader for that long.
        // The SAME bind IP as startup: a rename must not republish a record
        // pointing at a different interface than the listener is on.
        let (advertiser, resolved) = Advertiser::start_resolving_on(
            &name,
            self.local_addr.port(),
            self.identity.device_id(),
            &mut rand::thread_rng(),
            // The SAME normalisation as startup (see the call there): a rename
            // must not republish a literal wildcard.
            advertise_ip(self.local_addr.ip()),
        )?;
        let mut p = self.profile.lock().await;
        // The new advertiser is created BEFORE the old one is stopped (above vs
        // below), so there is no zero-advertisement window even though the lock
        // is now taken later.
        p.advertiser.stop();
        p.advertiser = advertiser;
        p.base_name = name;
        p.resolved_name = resolved.clone();
        // Presence carries the name, so a rename that skipped this would leave
        // peers showing the old one until their own announce refreshes.
        if let Some(presence) = &p.presence {
            if let Err(e) = presence
                .announce(&Presence::new(
                    self.identity.device_id(),
                    p.session_id,
                    resolved,
                    p.presence_state,
                ))
                .await
            {
                // Best-effort, exactly like the startup announce: the mDNS
                // record is already updated and presence is an enhancement.
                tracing::warn!("presence announce after rename failed: {e}");
            }
        }
        Ok(())
    }

    /// Set this device's advertised presence (online | away) and re-announce.
    /// The state is remembered so a later rename re-announces the SAME state
    /// instead of silently resetting the user to online.
    pub async fn set_presence(&self, state: PresenceState) -> Result<()> {
        let mut p = self.profile.lock().await;
        // Remembered even if the announce below fails, so a later rename
        // re-announces the state the user actually chose.
        p.presence_state = state;
        if let Some(presence) = &p.presence {
            if let Err(e) = presence
                .announce(&Presence::new(
                    self.identity.device_id(),
                    p.session_id,
                    p.resolved_name.clone(),
                    state,
                ))
                .await
            {
                // Best-effort, exactly like the startup announce and the
                // announce after a rename. On a host that routes IPv4
                // multicast only over loopback an announce is EHOSTUNREACH
                // (the same condition as the deliberately-ignored
                // two_sockets_on_one_host_exchange_beacons test), and a peer
                // that cannot be told our new state must not make the local
                // state change fail. The state is recorded above regardless.
                tracing::warn!("presence announce on set_presence failed: {e}");
            }
        }
        // Away is a self-declaration to peers, so the outbox drain must also
        // stop treating us as reachable. Presence is what tells a peer that,
        // and notify_peer_online only ever wakes the drain for OUR side, so
        // there is nothing further to do here.
        Ok(())
    }

    pub async fn pairing_bundle(&self) -> PairingBundle {
        PairingBundle::new(self.identity.public(), self.display_name().await)
    }

    pub async fn offer_pairing(
        &self,
        peer: PairingBundle,
        mode: PairMode,
        code: Option<String>,
    ) -> Result<()> {
        *self.pending_pairing.lock().await = Some(PendingPairing {
            arm: PendingArm::Expected(peer),
            mode,
            code,
        });
        Ok(())
    }

    /// Arm the accept slot for the FIRST inbound pairing without naming the
    /// peer. This is the host half of spec 3.3 Mode A: the host shows its QR
    /// and taps Arm, and needs no bundle of its own.
    ///
    /// One-shot by construction -- the accept loop TAKES the slot -- so a host
    /// that wants to pair a second device arms again. REPLACES any pending arm,
    /// exactly as `offer_pairing` does. See `PendingArm::Open` for what this
    /// stops constraining.
    pub async fn offer_inbound_pairing(&self, mode: PairMode) -> Result<()> {
        *self.pending_pairing.lock().await = Some(PendingPairing {
            arm: PendingArm::Open,
            mode,
            code: None,
        });
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
        // The host may have armed the OPEN slot (spec 3.3 Mode A: the joiner is
        // the only side that scanned, so the host has no bundle of ours), which
        // needs our static keys before it can build the Noise XX prologue. So
        // the joiner offers its identity in-band, exactly as pair_with_code
        // already does. This is ADDITIVE on the wire: a bundle-matched host
        // never reads it, because `recv_handshake` skips non-Handshake frames
        // and `pair` reads nothing between the Hello and the first handshake
        // message. A host that IS open-armed reads it here and refuses if the
        // advertised device id disagrees with the Hello.
        conn.send(
            0,
            RecordType::Control,
            Bytes::from(self.identity.public().to_cbor()?),
        )
        .await?;
        let local = self.pairing_bundle().await;
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
        Self::commit_pairing(&self.db, &pairing, &self.tx)?;
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
        let local = self.pairing_bundle().await;
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
        Self::commit_pairing(&self.db, &pairing, &self.tx)?;
        Ok((sas, pairing.peer_device_id))
    }

    pub async fn send_secure(
        &self,
        peer_device_id: [u8; 16],
        manifest: Manifest,
        paths: Vec<Option<PathBuf>>,
    ) -> Result<[u8; 16]> {
        let transfer_id = manifest.payload_id;
        send_secure_with(&self.sessions, peer_device_id, &manifest, &paths).await?;
        Ok(transfer_id)
    }

    /// Queue a send with no online peer present; the worker drains it on reconnect.
    /// W-FW-2: this is the production share entry point and it has NO in-repo
    /// caller yet, on purpose. daak-cli's `Send` must stay on blocking
    /// send_secure (it prints "sent <id>" and exits, so a queued id would be a
    /// lie). The caller that must be wired is the TurboModule/FFI share
    /// surface, which is Phase 4 work.
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

    /// Read one held-back item back and report what this device actually has.
    ///
    /// WHY A LOCAL RE-CHECK AND NOT A RE-FETCH. The prototype's button reads
    /// "Ask the sender again", which implies a receiver-initiated re-request.
    /// Daak's wire protocol cannot express that, and pretending it can is the
    /// one thing this method must not do. The protocol is PUSH-ONLY:
    /// `send_transfer` writes a manifest plus chunks and then reads exactly one
    /// Ack; `handle_inbound` only ever calls `receive_transfer`. No message lets
    /// a receiver name a payload and an item to a sender, and no path lets a
    /// sender serve one. `due_outbox` returns OUTBOUND rows only, so an inbound
    /// transfer has no outbox row to re-pend either. A real re-fetch is a new
    /// control message plus a new serve path on the sender -- Phase 7 wire work,
    /// not a screen.
    ///
    /// So this reports instead of re-requesting: it reads the held file,
    /// recomputes its BLAKE2b-256, and hands back BOTH fingerprints alongside
    /// what was really recorded about the item. It MUTATES NOTHING -- no state
    /// change, no move, no delete. There is deliberately no "recovered" branch,
    /// because there cannot be one: the held bytes are the exact bytes that
    /// just failed this comparison, so re-reading them can only reproduce the
    /// same hash and the same mismatch. The only way to make that branch fire
    /// would be to overwrite the sender's attested hash, which forges the one
    /// attestation that makes quarantine worth having.
    pub fn quarantine_report(
        &self,
        transfer_id: [u8; 16],
        item_index: u32,
    ) -> Result<QuarantineReport> {
        let item = require_item(&self.db, transfer_id, item_index)?;
        // The receiver recorded dest_path as the HELD path for a quarantined
        // item, so that is the file to read. Only its LEAF identifies the slot:
        // the full stored string is never joined onto the root, because a
        // persisted path is data and reading one back verbatim would turn a
        // corrupt row into a path-traversal primitive.
        let quarantine = Quarantine::new(self.out_dir.join("quarantine"));
        let held = quarantine.slot(&transfer_id, &held_leaf(&item)?);
        let expected = item.hash.ok_or_else(|| {
            CoreError::Protocol(format!(
                "item {item_index} of transfer {} has no fingerprint to check against",
                hex::encode(transfer_id)
            ))
        })?;
        let f = std::fs::File::open(&held).map_err(|e| {
            CoreError::Transfer(format!(
                "held-back file {} is unreadable: {e}",
                held.display()
            ))
        })?;
        let actual = crate::hash::blake2b256_reader(f)?;
        let transfer = self.db.get_transfer(&transfer_id)?;
        // The peer's PAIRED label. It is the only name this device ever wrote
        // down for that sender, so it is the only one that can be shown -- and
        // `None` (never recorded, pairing since revoked) stays `None` rather
        // than becoming an id prefix dressed up as a name.
        let sender_name = transfer
            .as_ref()
            .and_then(|t| self.db.get_pairing(&t.peer_device_id).ok().flatten())
            .and_then(|p| p.label);
        Ok(QuarantineReport {
            transfer_id,
            item_index,
            name: item.name.clone(),
            size: item.size,
            sender_name,
            sender_device_id: transfer.as_ref().map(|t| t.peer_device_id),
            received_at: transfer.as_ref().map(|t| t.updated_at),
            expected,
            actual,
            held_path: held.to_string_lossy().into_owned(),
        })
    }

    /// Every item this device is currently holding back, newest arrival first.
    ///
    /// The DISCOVERY half of `quarantine_report`. Without it the "Held back"
    /// screen would need the user to supply a transfer id and an item index they
    /// have never seen, and the only way to get those is to guess indexes until
    /// one stops erroring -- which would also mean hashing every item of every
    /// transfer to find the held ones. This walks the transfer rows, keeps the
    /// `quarantined` item rows and reads each one.
    ///
    /// One held item whose file has gone missing is an ERROR, not a silent
    /// skip: the row says bytes are being held, so a report that quietly omits
    /// it would leave a permanently-ignored item the screen can never offer to
    /// delete. `quarantine_report` is the authority on whether the file is
    /// readable, and this surfaces its verdict instead of hiding it.
    pub fn list_quarantine_reports(&self) -> Result<Vec<QuarantineReport>> {
        let mut out = Vec::new();
        for t in self.db.list_transfers(None, None)? {
            for item in self.db.list_items(&t.transfer_id)? {
                if item.state != "quarantined" {
                    continue;
                }
                out.push(self.quarantine_report(t.transfer_id, item.item_index)?);
            }
        }
        // Newest arrival first, matching the Inbox's own ordering, so the row a
        // user recognises is the first one they see. Stable on a tie because
        // `received_at` is a whole second.
        out.sort_by(|a, b| {
            b.received_at
                .cmp(&a.received_at)
                .then(b.item_index.cmp(&a.item_index))
        });
        Ok(out)
    }

    /// Discard a held-back item for good.
    ///
    /// Removes the held file and the item row, then recomputes the transfer's
    /// summary so a transfer whose last outstanding item the user gave up on
    /// stops reading as if something were still outstanding.
    ///
    /// The file goes first: a leftover row is a visible inconsistency the user
    /// could act on, whereas a leftover file that no row can find is not. A file
    /// that is ALREADY gone is success -- deleting it again is what the user
    /// asked for -- and require_item has already established that the row
    /// exists, so this cannot turn a bogus id into a silent no-op.
    pub fn delete_quarantined_item(&self, transfer_id: [u8; 16], item_index: u32) -> Result<()> {
        let item = require_item(&self.db, transfer_id, item_index)?;
        // ONLY a held-back item. `require_item` proves the row exists, which is
        // not enough: a `done` item's file lives at the receiver's final path,
        // and `held_leaf` would resolve that path's leaf into the QUARANTINE
        // root. For most items that names a file that is not there (the delete
        // then removes nothing and drops the row, silently orphaning a real
        // delivered file), and for a name a peer chose to collide with a held
        // one it would delete a DIFFERENT item's bytes. Refusing is the only
        // answer that cannot destroy the wrong file.
        if item.state != "quarantined" {
            return Err(CoreError::Protocol(format!(
                "item {item_index} of transfer {} is {:?}, not held back, so it is not held-back's file to delete",
                hex::encode(transfer_id),
                item.state
            )));
        }
        let held =
            Quarantine::new(self.out_dir.join("quarantine")).slot(&transfer_id, &held_leaf(&item)?);
        if let Err(e) = std::fs::remove_file(&held) {
            // NotFound means the goal is already met. Anything else is a real
            // failure the user has to hear about, because reporting a delete
            // that did not happen is the worst possible answer here.
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(CoreError::Transfer(format!(
                    "held-back file {} could not be deleted: {e}",
                    held.display()
                )));
            }
        }
        // Prune the per-payload directory so a long tail of deleted files leaves
        // no empty tree behind. Best effort: an empty directory is harmless and
        // must not fail the delete the user asked for.
        if let Some(dir) = held.parent() {
            let _ = std::fs::remove_dir(dir);
        }
        self.db.delete_item(&transfer_id, item_index)?;
        self.refresh_held_summary(&transfer_id)?;
        let _ = self.tx.send(EngineEvent::TransferItem {
            transfer_id,
            item_index,
            state: "failed".into(),
            dest_path: None,
        });
        Ok(())
    }

    /// Recompute a transfer's item_count and error text from the item rows that
    /// still exist, so recovering or deleting the last held-back item cannot
    /// leave a summary naming a file the user no longer has.
    fn refresh_held_summary(&self, transfer_id: &[u8; 16]) -> Result<()> {
        if self.db.get_transfer(transfer_id)?.is_none() {
            return Ok(());
        }
        let items = self.db.list_items(transfer_id)?;
        let held = items.iter().filter(|i| i.state == "quarantined").count();
        let error = (held > 0).then(|| format!("{held} item(s) quarantined after hash mismatch"));
        self.db
            .update_transfer_summary(transfer_id, items.len() as u32, error.as_deref())
    }

    /// R-T12-7: re-fetch one quarantined item without restarting the transfer.
    ///
    /// PARKED, and kept only so the state transition it performs stays pinned.
    /// It marks the item `pending` and pokes the outbox, and NOTHING consumes
    /// that: `due_outbox` returns outbound rows only, so an inbound transfer has
    /// no row to drain, and the wire protocol has no receiver-initiated
    /// re-fetch message (see `recheck_quarantined_item` for the full
    /// reasoning). A UI button wired to this would move a held-back file into a
    /// state that reads as "being fetched" while nothing fetches it, so no
    /// surface calls it. The user-facing operation is
    /// `recheck_quarantined_item`.
    pub fn retry_item(&self, transfer_id: [u8; 16], item_index: u32) -> Result<()> {
        if let Some(peer) = retry_item_with(&self.db, transfer_id, item_index)? {
            self.outbox.notify_peer_online(peer);
        }
        Ok(())
    }

    /// Called from the accept loop after a successful inbound transfer.
    /// Returns the row it wrote, so the caller can put THE PERSISTED row on the
    /// event bus rather than rebuilding it from the manifest a second time.
    fn record_inbox(db: &Db, manifest: &Manifest, saved_paths: &[String]) -> Result<InboxRow> {
        let summary = match manifest.kind {
            PayloadKind::Text => manifest
                .items
                .first()
                .and_then(|i| i.text.clone())
                .unwrap_or_default(),
            _ => format!("{} file(s)", manifest.binary_items().count()),
        };
        let row = InboxRow {
            id: manifest.payload_id,
            transfer_id: manifest.payload_id,
            peer_device_id: manifest.sender.device_id,
            kind: format!("{:?}", manifest.kind).to_lowercase(),
            item_count: manifest.items.len() as u32,
            summary,
            received_at: crate::manifest::now_ms() as i64 / 1000,
            // The destinations the receiver ACTUALLY created, harvested from
            // the TransferItem events receive_transfer already emits -- not a
            // recomputation from the manifest, which would name the final path
            // of an item that was remapped into quarantine.
            saved_paths: json_string_array(saved_paths),
        };
        db.add_inbox(&row)?;
        Ok(row)
    }

    /// Called by the accept loop for every inbound connection.
    #[allow(clippy::too_many_arguments)] // pending_pairing + pending_code are the two pairing slots
    pub(crate) async fn handle_inbound(
        identity: &Identity,
        db: &Db,
        out_dir: &Path,
        profile: &Mutex<Profile>,
        pending_pairing: &Mutex<Option<PendingPairing>>,
        pending_code: &Mutex<Option<String>>,
        pairing_tx: &mpsc::Sender<String>,
        tx: &broadcast::Sender<EngineEvent>,
        conn: &mut Connection<tokio::net::TcpStream>,
    ) -> Result<()> {
        let hello = read_hello(conn).await?;
        // Read the name INSIDE the lock and copy it: a rename swaps the whole
        // Profile, and a pairing bundle answered with a stale name would show
        // the peer a name this device no longer advertises.
        let local = PairingBundle::new(
            identity.public(),
            profile.lock().await.resolved_name.clone(),
        );
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
            Self::commit_pairing(db, &pairing, tx)?;
            let _ = pairing_tx.send(sas).await;
            return Ok(());
        }
        // The arm is a SINGLE slot, so it must not be consumed by a connection
        // that turns out not to be a pairing dial. Every inbound connection
        // reaches here -- an ordinary TRANSFER from an already-paired peer
        // looks exactly like a pairing dial up to the first frame after the
        // Hello -- so this INSPECTS a clone and only `take()`s the real slot
        // once the peer has actually been identified. Before this, `take()`
        // came first: any stray LAN connection burned the arm, the host's QR
        // kept rendering, and the genuine joiner was refused with no visible
        // cause.
        //
        // An EXPLICIT arm outranks "already paired": the arm names a bundle, so
        // the hello is compared against it (`expect_hello_matches_arm`) and a
        // match is a pairing even when a row already exists -- a host re-arming
        // for a device it has paired before must not have that re-pair routed
        // into the transfer handshake. Only the OPEN arm is ambiguous, and it
        // is the one that reads an in-band identity a transfer never sends: for
        // it alone does a pairing row mean "this is a transfer", which is what
        // makes the reviewer's probe pass rather than merely survive. An arm
        // clone is cheap and nothing is consumed until the peer is identified.
        let pending = match pending_pairing.lock().await.clone() {
            // The store is consulted ONLY for the open arm, and a failure to
            // read it is NOT fatal: this runs before the handshake, and the
            // joiner is waiting on the far end of a socket that would simply
            // close. `pairing_done_is_not_emitted_when_the_pairing_row_fails_to
            // persist` makes the store unusable on purpose to prove the commit
            // ordering, and a routing decision must not be what breaks it. An
            // unreadable store answers `false`, so the open arm is offered the
            // connection and the failure lands where it belongs -- in the
            // commit, after the handshake.
            Some(p) if p.arm == PendingArm::Open => {
                if db.get_pairing(&hello.device_id).ok().flatten().is_some() {
                    None
                } else {
                    Some(p)
                }
            }
            other => other,
        };
        if let Some(pending) = pending {
            let mode = pending.mode;
            let code = pending.code;
            // The peer bundle the Noise prologue is built from. On the open arm
            // it arrives IN-BAND, exactly as on the manual-code path above,
            // because the host has none and XX needs the peer's static before
            // the first handshake message.
            //
            // VERSION SKEW (accepted, fails CLOSED): an open-armed host
            // requires a joiner new enough to send that in-band identity. An
            // OLDER joiner sends no such frame, so `read_identity_public`
            // either waits for it or misparses the SPAKE2 bytes that arrive
            // instead, and the pairing is REFUSED. It is never trusted on a
            // guess: `Pairing::state` only ever becomes "trusted" after
            // `pair` returns Ok, so the failure mode is a refused pairing, not
            // a wrong one. The mirror image is safe and needs no handling --
            // an OLD host's Expected path never reads the extra frame,
            // `recv_handshake` loops past non-Handshake records, and the
            // in-band identity is simply buffered and ignored. No capability
            // flag is added for this; a refused pairing IS the behaviour.
            let expected = match pending.arm {
                PendingArm::Expected(bundle) => {
                    expect_hello_matches_arm(bundle.identity.device_id, hello.device_id)?;
                    bundle
                }
                PendingArm::Open => {
                    let peer_public = read_identity_public(conn).await?;
                    expect_open_hello_matches_identity(hello.device_id, peer_public.device_id)?;
                    // DELIBERATELY REDUNDANT with the identical check
                    // `pairing::pair` performs on this same IdentityPublic as
                    // its very first action. It is kept because this is a
                    // trust boundary and defence in depth here costs one call;
                    // it is NOT what protects the user. `pair` is.
                    if !verify_static_binding(
                        &peer_public.ed25519,
                        &peer_public.x25519,
                        &peer_public.static_sig,
                    ) {
                        return Err(CoreError::Protocol(
                            "open-arm peer identity binding failed".into(),
                        ));
                    }
                    let name = hex::encode(peer_public.device_id);
                    PairingBundle::new(peer_public, name)
                }
            };
            // The peer is identified and consistent with the arm, so THIS is
            // the pairing connection: consume the one-shot slot now. Finding it
            // already gone means a second joiner raced the first through the
            // clone-inspect above -- that loser is refused with a clear error
            // rather than silently falling through to the transfer path.
            if pending_pairing.lock().await.take().is_none() {
                return Err(CoreError::Protocol(
                    "pairing arm already consumed by another joiner".into(),
                ));
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
            Self::commit_pairing(db, &pairing, tx)?;
            let _ = pairing_tx.send(sas).await;
            return Ok(());
        }
        let pairing = db
            .get_pairing(&hello.device_id)?
            .ok_or_else(|| CoreError::Protocol("unpaired inbound connection".into()))?;
        let static_secret = zeroize::Zeroizing::new(identity.static_secret().to_bytes());
        // B3: the destinations the receiver actually created, read off the item
        // events as they are emitted. `on_item` is called synchronously by
        // receive_transfer on this task and the borrow ends when it returns, so
        // by the time recv_secure_transfer hands back the manifest the vec is
        // complete -- no lock, no channel, no await point in between.
        let mut saved_paths: Vec<String> = Vec::new();
        // R6: the real Db, not None -- inbound transfers are persisted so the
        // NACK-driven resume path (bitmaps, quarantine rows) is reachable.
        match recv_secure_transfer(
            conn,
            &static_secret,
            &pairing.static_dh_pub,
            out_dir,
            Some(db),
            |ev| {
                if let EngineEvent::TransferItem {
                    dest_path: Some(p), ..
                } = &ev
                {
                    saved_paths.push(p.clone());
                }
                let _ = tx.send(ev);
            },
        )
        .await
        {
            Ok(manifest) => {
                // C1 order: the inbox event goes FIRST. A `transfer.done`
                // handler that refetches the inbox must not be able to run
                // before the row it is about to refetch exists, and a
                // broadcast receiver sees these in send order. If the row
                // cannot be written there is no entry to report, so only the
                // warn! survives -- no event for a row that does not exist.
                match Self::record_inbox(db, &manifest, &saved_paths) {
                    Ok(row) => {
                        let _ = tx.send(EngineEvent::InboxReceived(row));
                    }
                    Err(e) => tracing::warn!("failed to record inbox row: {e}"),
                }
                let _ = tx.send(EngineEvent::TransferDone {
                    transfer_id: manifest.payload_id,
                });
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
        // B4: the outbox worker ticks every 5s and holds an Arc<Db> and the
        // session registry. Without this it kept draining rows for an engine
        // that is no longer serving anyone -- the last unreached production
        // caller of OutboxWorker::shutdown.
        self.outbox.shutdown();
        // The advertiser moved into the profile lock, so it is stopped through
        // it. A poisoned lock cannot happen on a tokio Mutex, so the expect is
        // unreachable rather than a recovery path.
        self.profile.lock().await.advertiser.stop();
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

/// The Expected-arm guard: the Hello the peer opened with must name the very
/// device the arm was matched to. Split out of `handle_inbound` so it can be
/// pinned by a test -- the integration probe could not reach it, because a
/// mismatched dialer also builds its Noise prologue from the WRONG bundle and
/// so fails the handshake first, for a different reason, with the guard never
/// reached. This is the only implementation of the check.
fn expect_hello_matches_arm(arm_device_id: [u8; 16], hello_device_id: [u8; 16]) -> Result<()> {
    if hello_device_id != arm_device_id {
        return Err(CoreError::Protocol("pairing hello device mismatch".into()));
    }
    Ok(())
}

/// The Open-arm guard: the peer claims an identity IN-BAND, and the Hello it
/// opened with must name that same device -- otherwise one frame is signed for
/// a device id the other is not. Split out for the same reason as above; this
/// is the only implementation of the check.
fn expect_open_hello_matches_identity(
    hello_device_id: [u8; 16],
    peer_device_id: [u8; 16],
) -> Result<()> {
    if hello_device_id != peer_device_id {
        return Err(CoreError::Protocol("open-arm hello device mismatch".into()));
    }
    Ok(())
}

/// A long-lived per-peer session is not free: it holds a TCP socket, a Noise
/// session (with rekey state) and a replay window for as long as the peer stays
/// in the map. 5 minutes of no sends is enough that the next send re-handshakes
/// in a few ms on a LAN.
const SESSION_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// Send a manifest and its staged/binary paths over the peer's registry session.
///
/// Both `Engine::send_secure` and the outbox drain land here, so a direct send
/// and a drained send share one connection. R-T11-10: a send error drops the
/// session and retries exactly ONCE through `get_or_connect`, which re-dials.
/// One retry, not a loop -- an unbounded reconnect loop against a peer that
/// refuses connections is a DoS.
// ponytail: the registry lock is held across a full dial + Noise handshake, so
// a cold peer serializes every other peer's connect. N is small (a room's worth
// of devices) and a LAN handshake is ~ms; shard the registry per peer, or dial
// outside the lock, if that ever stops being true.
async fn send_secure_with<T: crate::net::FrameTransport + Send>(
    sessions: &SharedSessions<T>,
    peer_device_id: [u8; 16],
    manifest: &Manifest,
    paths: &[Option<PathBuf>],
) -> Result<()> {
    let handle = sessions.lock().await.get_or_connect(peer_device_id).await?;
    match send_on_session(&handle, manifest, paths).await {
        Ok(()) => return Ok(()),
        // B4: a hash mismatch is a PERMANENT verdict on bytes the receiver
        // already holds, so the retry below cannot change it -- it would upload
        // the whole payload a second time to earn the identical answer.
        Err(e @ CoreError::Quarantined { .. }) => return Err(e),
        Err(_) => {}
    }
    // ponytail: the retry re-sends the WHOLE payload, so a transient error after
    // the receiver already wrote the bytes costs a full re-send. Upgrade to the
    // NACK-driven ranges (transfer::resume) once the receiver can use them.
    sessions.lock().await.remove(&peer_device_id);
    let handle = sessions.lock().await.get_or_connect(peer_device_id).await?;
    send_on_session(&handle, manifest, paths).await?;
    Ok(())
}

/// One send over an existing session, holding the session lock for the whole
/// transfer (a session multiplexes one transfer at a time). A failure marks the
/// session broken so nobody reuses the half-written connection.
async fn send_on_session<T: crate::net::FrameTransport + Send>(
    handle: &crate::session::SessionHandle<T>,
    manifest: &Manifest,
    paths: &[Option<PathBuf>],
) -> Result<()> {
    let mut s = handle.lock().await;
    let r = crate::transfer::send_transfer(&mut s.conn, manifest, paths, &[], |_| {}).await;
    // touch on BOTH paths: `last_used` means "last attempted", which is what
    // eviction wants -- a repeatedly-failing peer must not keep a stale
    // last_used and pin the session past its idle timeout.
    s.touch();
    if r.is_err() {
        s.mark_broken();
    }
    r
}

/// What the outbox drain closure needs; the closure itself is a plain `Fn`, so
/// the per-row state is cloned into a task per row.
struct DrainCtx<T = TcpConn> {
    db: Arc<Db>,
    staging: Arc<Staging>,
    /// R-T11-12: the SAME sessions the Engine holds, so a drained send reuses
    /// (and re-dials) the same per-peer connection a direct send would.
    sessions: SharedSessions<T>,
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
    // R-T10-3: every UPDATE below matches zero rows for an unknown id, so
    // without this guard cancel would report success for a row that does not
    // exist. The guard is load-bearing, not defensive noise.
    let row = require_outbox(db, &transfer_id)?;
    let won = db.mark_outbox_terminal_failed(&transfer_id, "cancelled")?;
    // B2: the outbox UPDATE is guarded on state IN ('pending','sending'), so a
    // row that is already 'done' (delivered) or 'awaiting_ack' LOST the race and
    // the transfers row must keep saying so. Writing 'canceled' unconditionally
    // is how an already-delivered share was relabelled as cancelled.
    if won {
        // "canceled" is spec 4.2's transfers.state enum (ONE 'l'), not the
        // brief's "cancelled"; do not "fix" it back.
        db.set_transfer_state(&transfer_id, "canceled")?;
    } else {
        // The row was already done (delivered) or awaiting_ack. Cancel did
        // not win, so the outbox is the authority and the staged copy is
        // still wanted: a delivered share's staging is what a later retry
        // would re-send from. Deleting it here would turn a no-op cancel into
        // silent data loss while the row still reads `done`.
        return Ok(());
    }
    staging.cleanup(&row.payload_id)
}

/// Returns the peer to notify, if the row was actually re-armed.
pub fn retry_with(db: &Db, transfer_id: [u8; 16]) -> Result<Option<[u8; 16]>> {
    // R-T10-3, same reasoning as cancel_with.
    let row = require_outbox(db, &transfer_id)?;
    if !db.retry_outbox_now(&transfer_id)? {
        return Ok(None);
    }
    // "queued" is spec 4.2's transfers.state for a re-armed send; "pending"
    // is outbox vocabulary and is not a member of that enum.
    db.set_transfer_state(&transfer_id, "queued")?;
    Ok(Some(row.peer_device_id))
}

/// Returns the peer to notify, if the item was found and re-armed.
/// R-T12-7: Db::set_item_state matches zero rows for an unknown
/// (transfer_id, item_index), so both rows are checked explicitly first --
/// otherwise Retry on garbage returns Ok(()) and silently does nothing.
pub fn retry_item_with(
    db: &Db,
    transfer_id: [u8; 16],
    item_index: u32,
) -> Result<Option<[u8; 16]>> {
    let row = db.get_transfer(&transfer_id)?.ok_or_else(|| {
        CoreError::Protocol(format!(
            "no transfer {} to retry an item of",
            hex::encode(transfer_id)
        ))
    })?;
    db.get_item(&transfer_id, item_index)?.ok_or_else(|| {
        CoreError::Protocol(format!(
            "no item {item_index} on transfer {}",
            hex::encode(transfer_id)
        ))
    })?;
    // "pending" is the re-armed item state; transfers.state is a different
    // enum (see retry_with) and is deliberately NOT touched here.
    db.set_item_state(&transfer_id, item_index, "pending")?;
    Ok(Some(row.peer_device_id))
}

/// The item row a quarantine action names, or an error naming what is missing.
///
/// Both the UPDATEs these actions follow match ZERO rows for an unknown
/// (transfer_id, item_index), so without this guard "Check it again" on a
/// transfer the user no longer has would report success and do nothing. Same
/// reasoning as `require_outbox`, and the reason this reads the row first
/// rather than trusting the write's affected-row count.
pub fn require_item(
    db: &Db,
    transfer_id: [u8; 16],
    item_index: u32,
) -> Result<crate::store::transfers::ItemRow> {
    db.get_transfer(&transfer_id)?.ok_or_else(|| {
        CoreError::Protocol(format!(
            "no transfer {} to act on an item of",
            hex::encode(transfer_id)
        ))
    })?;
    db.get_item(&transfer_id, item_index)?.ok_or_else(|| {
        CoreError::Protocol(format!(
            "no item {item_index} on transfer {}",
            hex::encode(transfer_id)
        ))
    })
}

/// The name that identifies an item's quarantine slot.
///
/// A quarantined item's `dest_path` is the HELD path, and `Quarantine::slot`
/// takes a NAME and appends it under `<root>/<hex payload_id>/`. So the leaf has
/// to be recovered from whichever of the two recorded strings is present:
/// `dest_path` first, because that is what the receiver wrote for this exact
/// outcome, and `name` as the fallback for a row persisted before dest_path
/// was recorded. Only the LAST component is ever used, so a stored path with a
/// traversal prefix cannot escape the quarantine root. `slot` applies the same
/// reduction independently; this one keeps the caller honest about passing a
/// name rather than a path.
fn held_leaf(item: &crate::store::transfers::ItemRow) -> Result<String> {
    let from_path = item
        .dest_path
        .as_deref()
        .and_then(|p| Path::new(p).file_name())
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty());
    match from_path.or(item.name.as_deref()) {
        Some(n) => Ok(n.to_owned()),
        None => Err(CoreError::Protocol(format!(
            "item {} has no recorded name to look it up by",
            item.item_index
        ))),
    }
}

/// Back off and retry, or give up. The one decision the retry path makes.
/// Returns the transfers.state the row should now show: `paused` while it is
/// still retrying (B2 -- a row in backoff is not terminal, and 'failed' would
/// be indistinguishable from the give-up) and `failed` once it gave up.
///
/// `None` means the outbox transition LOST its guard -- the row was canceled
/// or settled by someone else while this drain was in flight -- so there is no
/// transfers write to make. Returning the state anyway is what relabelled a
/// canceled share `paused` FOREVER, because its outbox row is terminal and is
/// never re-pended.
fn settle_failed_attempt(
    db: &Db,
    id: &[u8; 16],
    attempts: u32,
    jitter: u64,
) -> Result<Option<&'static str>> {
    let now = crate::manifest::now_ms() as i64 / 1000;
    if attempts + 1 >= MAX_DELIVERY_ATTEMPTS {
        let won = db
            .mark_outbox_terminal_failed(id, &format!("gave up after {} attempts", attempts + 1))?;
        Ok(won.then_some("failed"))
    } else {
        let won = db.mark_outbox_failed(id, now, jitter)?;
        Ok(won.then_some("paused"))
    }
}

/// Rebuild a queued send from its row and push it, then settle the row state.
async fn drain_outbox_row<T: crate::net::FrameTransport + Send + 'static>(
    ctx: DrainCtx<T>,
    row: OutboxRow,
) {
    let db = &ctx.db;
    let retry = |jitter: u64| {
        // R-T10-5: cap the retries. Without this a permanently unreachable peer
        // (or a permanently bad file) retries forever and never leaves 'failed'.
        // Only write when this drain still OWNS the row; see the None arm on
        // settle_failed_attempt.
        if let Ok(Some(state)) = settle_failed_attempt(db, &row.id, row.attempts, jitter) {
            let _ = db.set_transfer_state(&row.id, state);
        }
    };

    // Settle terminally, and only if this drain still OWNS the row. Used by
    // the two permanent-failure paths below.
    let terminal = |db: &Db, why: String| {
        if db
            .mark_outbox_terminal_failed(&row.id, &why)
            .unwrap_or(false)
        {
            // B2: the transfers row was written 'queued' at enqueue; leaving it
            // there forever is the one state the UI cannot explain. The outbox
            // write is the authority, so this is gated on it.
            let _ = db.set_transfer_state(&row.id, "failed");
        }
    };

    let manifest = match Manifest::from_cbor(&row.manifest) {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!("outbox drain: row {} undecodable: {e}", hex::encode(row.id));
            // An undecodable manifest is permanent: retrying re-reads the same
            // bytes forever. Terminal instead of burning the attempt budget.
            terminal(db, format!("undecodable manifest: {e}"));
            return;
        }
    };
    // `paths` is indexed by item index (sender.rs looks it up with
    // `item.index as usize`), not by position among the items.
    let mut paths: Vec<Option<PathBuf>> = vec![None; manifest.items.len()];
    for item in &manifest.items {
        if item.is_binary() {
            let path = ctx
                .staging
                .staged_path(&row.payload_id, item.name.as_deref().unwrap_or_default());
            // B3: a staged file that is NOT THERE will still not be there on
            // the next attempt, so retrying burns all 8 attempts over ~35
            // minutes to arrive at the same failure. The reachable way to get
            // here is cancel (which removes staging) followed by retry, which
            // re-arms the row -- the SEMANTICS of that pair are parked for the
            // user, but the harm (a 35 minute silent burn) is not. Terminal on
            // the first attempt, exactly like an undecodable manifest above.
            if !path.exists() {
                tracing::warn!(
                    "outbox drain: row {} staged file {} is gone",
                    hex::encode(row.id),
                    path.display()
                );
                terminal(db, format!("staged file is missing: {}", path.display()));
                return;
            }
            paths[item.index as usize] = Some(path);
        }
    }
    // R-D: an unknown peer is a failure, not a panic -- the connect closure
    // returns "not discovered" and the row goes back to pending with backoff.
    match send_secure_with(&ctx.sessions, row.peer_device_id, &manifest, &paths).await {
        // R-C: send_transfer already read the peer's Ack and returns Ok ONLY on
        // complete && hash_ok (Err on mismatch/close), so Ok(()) IS the ack.
        Ok(_) => {
            // B2: gate the transfers write on the outbox transition actually
            // having matched a row. A drain whose row was canceled mid-send
            // matches nothing here, and reporting that share as 'done' to the
            // UI is the worst possible direction for the wrong state.
            if db.mark_outbox_awaiting_ack(&row.id).unwrap_or(false)
                && db.mark_outbox_done(&row.id).unwrap_or(false)
            {
                // F4: the transfers row enqueue wrote has to follow the row to
                // its end, or a delivered share stays "queued" in the UI
                // forever. Same best-effort treatment as the settles beside it:
                // a missing row must not turn a successful send into a failed
                // drain.
                let _ = db.set_transfer_state(&row.id, "done");
            }
        }
        Err(e) => {
            // B4: the receiver QUARANTINED an item. That is a verdict about
            // these exact bytes, not a transport hiccup, so it must not enter
            // the retry path: retrying re-sends the same payload, the receiver
            // recomputes the same hash, and the sender burns all 8 attempts
            // over ~35 minutes before a row that was never going to succeed
            // reads 'failed'. Record what the receiver said, settle once, stop.
            //
            // Only the item the ack NAMES is marked. The receiver reports the
            // FIRST failed item and AckMsg has room for exactly one, so the
            // sender does NOT know whether a manifest with several bad items
            // quarantined one or five. Marking them all would be a guess, and a
            // guess that writes 'quarantined' onto files the receiver actually
            // accepted is worse than silence. The honest one-item record
            // leaves the other items with NO ROW AT ALL, which is accurate:
            // this sender cannot see their outcome, and the receiver's own DB
            // is authoritative about them anyway.
            if let CoreError::Quarantined { item_index, .. } = e {
                // 'quarantined' is transfer_items vocabulary (spec 4.2), the
                // SAME word the receiver writes, so both sides agree on what a
                // held file is.
                //
                // The row is written HERE, from the manifest already in hand,
                // rather than with a bare set_item_state: nothing on the
                // outbound path creates sender-side transfer_items rows, so an
                // UPDATE would match zero rows and the verdict would evaporate.
                // A local DB write must not fail a drain, hence the `let _`.
                //
                // Two things the next reader will otherwise assume away:
                //  - NOTHING reads this row yet. There is no listItems in the
                //    UDL, no items variant in IpcRequest (only ListTransfers
                //    and ListInbox) and no item accessor in packages/core, so
                //    the row is DB-only today. Surfacing it is a Phase 4
                //    listItems job.
                //  - The verdict's REASON is persisted nowhere the user can
                //    see it: the outbox table has no error column and
                //    set_transfer_state writes only state + updated_at, so
                //    `why` below is consumed by tracing::warn! alone. The
                //    user-visible effect of this whole branch is therefore
                //    that a quarantined share fails IMMEDIATELY instead of
                //    after ~35 minutes of retries -- the wording, not the
                //    timing, is what Phase 4 has to add.
                match manifest.items.iter().find(|i| i.index == item_index) {
                    Some(item) => {
                        let _ = db.upsert_item(&crate::store::transfers::ItemRow {
                            transfer_id: row.id,
                            item_index: item.index,
                            item_type: item.item_type.as_str().to_string(),
                            name: item.name.clone(),
                            mime: item.mime.clone(),
                            size: item.size,
                            hash: item.hash,
                            // Sender side: there is no local file at a
                            // destination, and inventing one would be a lie.
                            dest_path: None,
                            state: "quarantined".into(),
                        });
                    }
                    // The ack names an index this manifest does not have, so
                    // there is no item to name and guessing one would be worse
                    // than recording nothing. The verdict itself still settles
                    // the outbox row, but see below: the REASON survives only
                    // in this log line and on the item row.
                    None => tracing::warn!(
                        "outbox drain: peer quarantined item {item_index}, which is not in the manifest"
                    ),
                }
                tracing::warn!(
                    "outbox drain: peer quarantined item {} of transfer {}",
                    item_index,
                    hex::encode(row.id),
                );
                terminal(
                    db,
                    format!("receiver quarantined item {item_index} after a hash mismatch"),
                );
                return;
            }
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

    /// B3: the saved_paths column is hand-built JSON that both bridges parse
    /// with serde_json. A path that needs escaping must still parse, and a
    /// control byte must not be passed through raw -- serde_json rejects a raw
    /// control in a string, and the row would bridge as `null` (the corrupt-row
    /// signal) instead of a real list. daak-core cannot assert this with
    /// serde_json (it has no such dependency), so these are the exact strings
    /// serde_json's own escaping produces, pinned here and on the bridge side.
    #[test]
    fn saved_paths_json_escapes_what_a_path_can_contain() {
        assert_eq!(json_string_array(&[]), "[]");
        assert_eq!(
            json_string_array(&["/tmp/a.bin".into()]),
            r#"["/tmp/a.bin"]"#
        );
        assert_eq!(
            json_string_array(&["/tmp/a".into(), "/tmp/b".into()]),
            r#"["/tmp/a","/tmp/b"]"#
        );
        assert_eq!(
            json_string_array(&[r#"C:\tmp\q"#.into(), r#"/a"b"#.into()]),
            r#"["C:\\tmp\\q","/a\"b"]"#
        );
        assert_eq!(
            json_string_array(&["/tmp/\u{1}tab\t\nnl\r\u{8}\u{c}".into()]),
            r#"["/tmp/\u0001tab\t\nnl\r\b\f"]"#
        );
    }

    /// Finding 3. Both device-id guards are pinned here, as UNIT tests on the
    /// guard itself, because neither can be reached through the public API:
    ///
    /// * the Expected-arm case -- a mismatched dialer ALSO builds its Noise
    ///   prologue from the wrong bundle, so the handshake fails first and for a
    ///   different reason, with the guard never reached. The pre-existing
    ///   integration test `a_bundle_matched_arm_still_refuses_an_inbound_from_a
    ///   _different_device` passes on that earlier failure, which is exactly
    ///   why a mutation of the guard left all seven tests green;
    /// * the Open-arm case -- reaching it needs a Hello that names one device
    ///   and an in-band identity that names another, and no Engine-initiated
    ///   dial produces that (the joiner derives both from the same Identity).
    ///
    /// What these prove: the guard REJECTS a mismatch with its own specific
    /// error, and ACCEPTS a match. They do not prove the guard is wired into
    /// the accept path -- the call sites above are the wiring, and the two are
    /// one-liners with no branch of their own.
    #[test]
    fn the_expected_arm_rejects_a_hello_naming_a_different_device() {
        let arm = [1u8; 16];
        assert!(expect_hello_matches_arm(arm, arm).is_ok());
        let err = expect_hello_matches_arm(arm, [2u8; 16]).unwrap_err();
        assert!(
            err.to_string().contains("pairing hello device mismatch"),
            "a specific rejection, not a generic one: {err}"
        );
    }

    #[test]
    fn the_open_arm_rejects_a_hello_disagreeing_with_the_in_band_identity() {
        let id = [3u8; 16];
        assert!(expect_open_hello_matches_identity(id, id).is_ok());
        let err = expect_open_hello_matches_identity(id, [4u8; 16]).unwrap_err();
        assert!(
            err.to_string().contains("open-arm hello device mismatch"),
            "a specific rejection, not a generic one: {err}"
        );
    }

    #[test]
    fn accept_error_classifies_protocol_rejection_as_non_fatal() {
        assert!(!accept_error_is_fatal(&crate::error::CoreError::Protocol(
            "x".into()
        )));
        assert!(accept_error_is_fatal(&crate::error::CoreError::Io(
            std::io::Error::other("boom")
        )));
    }

    // B2 (4): the FAILURE path was the one settle round 2 left ungated. A
    // canceled row is terminal and is never re-pended, so writing `paused`
    // there stranded a canceled share in a retrying state permanently -- the
    // same wrong-direction bug as the success path, one branch over.
    #[test]
    fn a_lost_backoff_guard_writes_no_transfer_state_at_all() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        let root = tempfile::tempdir().unwrap();
        let staging = Staging::new(root.path().to_path_buf());
        let manifest = Manifest::text("race");
        let id = crate::outbox::enqueue(&db, &staging, &[3u8; 16], &manifest, &[]).unwrap();

        // Cancel owns the row; the drain's backoff guard matches nothing.
        cancel_with(&db, &staging, id).unwrap();
        assert_eq!(
            settle_failed_attempt(&db, &id, 0, 0).unwrap(),
            None,
            "a lost guard must yield no state to write"
        );
        assert_eq!(
            db.get_transfer(&id).unwrap().unwrap().state,
            "canceled",
            "a canceled share must not read as retrying"
        );
        // The winning case still reports the state. Different text, because
        // the outbox primary key IS the payload id and Manifest::text derives
        // it from the content.
        let other =
            crate::outbox::enqueue(&db, &staging, &[4u8; 16], &Manifest::text("other"), &[])
                .unwrap();
        assert!(db.mark_outbox_sending(&other).unwrap());
        assert_eq!(
            settle_failed_attempt(&db, &other, 0, 0).unwrap(),
            Some("paused")
        );
    }

    // B2 (1): the drain settles a row whose outbox transition lost every
    // guard, and the transfers write was unconditional -- so a share the user
    // canceled mid-send was reported to the UI as DELIVERED. The outbox
    // transition is the authority; the transfers row only follows it.
    #[test]
    fn a_row_canceled_mid_sending_is_never_relabelled_done() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        let root = tempfile::tempdir().unwrap();
        let staging = Staging::new(root.path().to_path_buf());
        let manifest = Manifest::text("race");
        let id = crate::outbox::enqueue(&db, &staging, &[3u8; 16], &manifest, &[]).unwrap();

        // The drain claimed the row, the user cancelled mid-flight, then the
        // drain's send completed and settled.
        assert!(db.mark_outbox_sending(&id).unwrap());
        cancel_with(&db, &staging, id).unwrap();
        assert!(
            !db.mark_outbox_awaiting_ack(&id).unwrap(),
            "guard must lose"
        );
        assert!(!db.mark_outbox_done(&id).unwrap(), "guard must lose");

        assert_eq!(
            db.get_transfer(&id).unwrap().unwrap().state,
            "canceled",
            "a canceled share must stay canceled, not become done"
        );
    }

    // B2 (2): cancelling an already-DELIVERED row must not relabel it. The
    // outbox UPDATE is guarded on state IN ('pending','sending') and loses, so
    // the transfers write must not happen either.
    #[test]
    fn cancelling_a_delivered_row_leaves_it_done() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        let root = tempfile::tempdir().unwrap();
        let staging = Staging::new(root.path().to_path_buf());
        let manifest = Manifest::text("delivered");
        let id = crate::outbox::enqueue(&db, &staging, &[3u8; 16], &manifest, &[]).unwrap();
        db.mark_outbox_sending(&id).unwrap();
        db.mark_outbox_awaiting_ack(&id).unwrap();
        db.mark_outbox_done(&id).unwrap();
        db.set_transfer_state(&id, "done").unwrap();

        cancel_with(&db, &staging, id).unwrap();
        assert_eq!(
            db.get_outbox(&id).unwrap().unwrap().state,
            "done",
            "the outbox row stays delivered"
        );
        assert_eq!(
            db.get_transfer(&id).unwrap().unwrap().state,
            "done",
            "an already-delivered share must not read as cancelled"
        );
    }

    // B2 (3): a transient failure is NOT terminal. 'paused' is spec 4.2's
    // honest state for a row in retry backoff; 'failed' is the give-up. The
    // old code wrote 'failed' on the FIRST failed attempt, which made a row
    // about to be retried indistinguishable from one that gave up.
    #[test]
    fn a_backed_off_attempt_reads_paused_and_the_give_up_reads_failed() {
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
            state: "pending".into(),
            created_at: 0,
            updated_at: 0,
        })
        .unwrap();

        // The backoff guard is `sending -> pending`, so a row that is still
        // `pending` never matched it: this assertion passed VACUOUSLY before
        // settle_failed_attempt started reporting the lost guard.
        assert!(db.mark_outbox_sending(&[1u8; 16]).unwrap());
        assert_eq!(
            settle_failed_attempt(&db, &[1u8; 16], 0, 0).unwrap(),
            Some("paused")
        );
        // A SECOND row for the give-up: the first row is no longer `sending`
        // (the backoff just moved it), so its guard would lose and the answer
        // would be None for the wrong reason.
        db.enqueue_outbox(&OutboxRow {
            id: [9u8; 16],
            payload_id: [8u8; 16],
            peer_device_id: [3u8; 16],
            manifest: vec![],
            total_bytes: 0,
            attempts: 0,
            next_attempt_at: 0,
            state: "sending".into(),
            created_at: 0,
            updated_at: 0,
        })
        .unwrap();
        assert_eq!(
            settle_failed_attempt(&db, &[9u8; 16], MAX_DELIVERY_ATTEMPTS - 1, 0).unwrap(),
            Some("failed"),
            "the give-up is the only terminal failure"
        );
    }

    // B3: cancel removes the staged bytes but leaves the outbox row in
    // 'failed', which retry accepts -- so cancel->retry on a FILE share
    // re-arms a row whose payload no longer exists. The SEMANTICS of that pair
    // are a parked user decision; the HARM is not: the drain used to burn all
    // 8 attempts over ~35 minutes to reach the same failure. A staged path
    // that is absent is permanent (exactly like an undecodable manifest), so
    // it settles terminally on the FIRST attempt.
    #[tokio::test]
    async fn a_rearmed_row_with_no_staged_file_settles_on_the_first_attempt() {
        let db = Arc::new(Db::open_in_memory().unwrap());
        db.migrate().unwrap();
        let root = tempfile::tempdir().unwrap();
        let staging = Arc::new(Staging::new(root.path().to_path_buf()));
        let src = tempfile::tempdir().unwrap();
        let f = src.path().join("a.bin");
        std::fs::write(&f, b"data").unwrap();
        let item =
            crate::manifest::Item::from_file(0, &f, crate::manifest::CHUNK_SIZE_DEFAULT).unwrap();
        let manifest = Manifest::batch(
            crate::manifest::DeviceRef {
                device_id: [9u8; 16],
                name: "local".into(),
            },
            vec![item],
        )
        .unwrap();
        let id = crate::outbox::enqueue(
            &db,
            &staging,
            &[9u8; 16],
            &manifest,
            std::slice::from_ref(&f),
        )
        .unwrap();

        cancel_with(&db, &staging, id).unwrap();
        // Phase 3 ruling R-T10-3, unchanged: retry DOES re-arm a canceled row.
        assert_eq!(retry_with(&db, id).unwrap(), Some([9u8; 16]));
        assert!(db.mark_outbox_sending(&id).unwrap());

        let row = db.get_outbox(&id).unwrap().unwrap();
        // An empty registry means the send leg cannot be reached, which is the
        // point: the missing-file check fires FIRST.
        let sessions: SharedSessions = Arc::new(Mutex::new(SessionRegistry::new(
            std::time::Duration::from_secs(1),
            Box::new(|_| -> BoxFutureConn {
                Box::pin(async { unreachable!("a missing staged file must not dial") })
            }) as BoxConnect,
        )));
        drain_outbox_row(
            DrainCtx {
                db: db.clone(),
                staging: staging.clone(),
                sessions,
            },
            row,
        )
        .await;

        let after = db.get_outbox(&id).unwrap().unwrap();
        assert_eq!(after.state, "failed", "settled terminally");
        assert_eq!(
            after.attempts, 0,
            "a permanent failure must not burn the retry budget"
        );
        assert_eq!(
            db.get_transfer(&id).unwrap().unwrap().state,
            "failed",
            "the transfers row follows the terminal settle (B2)"
        );
        assert!(
            db.due_outbox(i64::MAX).unwrap().is_empty(),
            "and it is not due again"
        );
    }

    // ---------------------------------------------------------------- B4 ---
    // A receiver-side QUARANTINE is a verdict, not a transport failure. The
    // old code returned the same Err for both, so the generic retry path
    // burned the whole budget (~35 min) and the sender's UI said "failed" for
    // a file the receiver deliberately held. Socket-free: a MemConn-backed
    // registry plus a stub peer answers the ack, like session.rs's own test.
    fn stub_peer_registry(
        hash_ok: bool,
        item_index: u32,
    ) -> (
        SharedSessions<crate::net::secure::MemConn>,
        Arc<std::sync::atomic::AtomicUsize>,
    ) {
        let connects = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let c = connects.clone();
        let sessions: SharedSessions<crate::net::secure::MemConn> =
            Arc::new(Mutex::new(SessionRegistry::new(
                std::time::Duration::from_secs(30),
                Box::new(move |_p: [u8; 16]| {
                    let c = c.clone();
                    Box::pin(async move {
                        c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        let (mine, mut theirs) = crate::net::secure::SecureConnection::<
                            crate::net::secure::MemConn,
                        >::test_pair();
                        tokio::spawn(async move {
                            use crate::net::FrameTransport;
                            let mut expect: Option<(Vec<u8>, u64)> = None;
                            let mut chunks = 0usize;
                            loop {
                                match theirs.recv().await {
                                    Ok(Some(f)) if f.kind == RecordType::Manifest => {
                                        // Read the whole manifest, then EVERY
                                        // chunk, and only then hash and ack --
                                        // what a real receiver does. Acking
                                        // after one chunk and hanging up would
                                        // test a broken peer, not a verdict.
                                        if let Ok(m) = Manifest::from_cbor(&f.body) {
                                            let total: u64 = m
                                                .items
                                                .iter()
                                                .map(|i| i.chunk_count.unwrap_or(0))
                                                .sum();
                                            expect = Some((m.payload_id.to_vec(), total));
                                        }
                                    }
                                    Ok(Some(f)) if f.kind == RecordType::Chunk => chunks += 1,
                                    Ok(Some(_)) => {}
                                    Ok(None) | Err(_) => return,
                                }
                                let Some((pid, total)) = expect.as_ref() else {
                                    continue;
                                };
                                if chunks < *total as usize {
                                    continue;
                                }
                                let ack = crate::control::AckMsg {
                                    transfer_id: <[u8; 16]>::try_from(pid.as_slice()).unwrap(),
                                    item_index,
                                    complete: true,
                                    hash_ok,
                                };
                                let _ = theirs
                                    .send(
                                        crate::session::CONTROL_STREAM,
                                        RecordType::Ack,
                                        Bytes::from(ack.to_cbor().unwrap()),
                                    )
                                    .await;
                                return;
                            }
                        });
                        Ok(mine)
                    })
                        as crate::session::BoxFutureConn<crate::net::secure::MemConn>
                }) as crate::session::BoxConnect<crate::net::secure::MemConn>,
            )));
        (sessions, connects)
    }

    /// One real file, staged and enqueued exactly as a production send is, and
    /// NOT ONE LINE MORE. There is deliberately no `upsert_item` here: the
    /// sender's own item row is the code under test (nothing on the outbound
    /// path writes one today), and hand-inserting it in the fixture would let a
    /// green suite hide that the production path records nothing.
    fn enqueued_file(db: &Db, staging: &Staging) -> [u8; 16] {
        let src = tempfile::tempdir().unwrap();
        let f = src.path().join("a.bin");
        std::fs::write(&f, b"data").unwrap();
        let item =
            crate::manifest::Item::from_file(0, &f, crate::manifest::CHUNK_SIZE_DEFAULT).unwrap();
        let manifest = Manifest::batch(
            crate::manifest::DeviceRef {
                device_id: [9u8; 16],
                name: "local".into(),
            },
            vec![item],
        )
        .unwrap();
        crate::outbox::enqueue(db, staging, &[9u8; 16], &manifest, std::slice::from_ref(&f))
            .unwrap()
    }

    async fn drain_one(
        db: &Arc<Db>,
        staging: &Arc<Staging>,
        sessions: SharedSessions<crate::net::secure::MemConn>,
        id: [u8; 16],
    ) {
        assert!(
            db.mark_outbox_sending(&id).unwrap(),
            "the drain claims its row"
        );
        let row = db.get_outbox(&id).unwrap().unwrap();
        drain_outbox_row(
            DrainCtx {
                db: db.clone(),
                staging: staging.clone(),
                sessions,
            },
            row,
        )
        .await;
    }

    /// B4 core: a hash-mismatch ack must NOT go through the generic retry
    /// path. The row settles on the FIRST attempt, the named item reads
    /// "quarantined" -- the one word from spec 4.2's vocabulary that the
    /// receiver also writes, so both sides name a held file the same way.
    #[tokio::test]
    async fn a_hash_mismatch_ack_quarantines_the_item_instead_of_retrying() {
        let db = Arc::new(Db::open_in_memory().unwrap());
        db.migrate().unwrap();
        let root = tempfile::tempdir().unwrap();
        let staging = Arc::new(Staging::new(root.path().to_path_buf()));
        let id = enqueued_file(&db, &staging);

        let (sessions, _connects) = stub_peer_registry(false, 0);
        drain_one(&db, &staging, sessions, id).await;

        let row = db.get_outbox(&id).unwrap().unwrap();
        assert_eq!(
            row.state, "failed",
            "a quarantine is terminal: the receiver will never accept these bytes"
        );
        assert_eq!(
            row.attempts, 0,
            "a permanent verdict must not burn a retry attempt"
        );
        assert!(
            db.due_outbox(i64::MAX).unwrap().is_empty(),
            "and it must not be due again"
        );
        assert_eq!(
            db.get_transfer(&id).unwrap().unwrap().state,
            "failed",
            "the transfers row follows the terminal settle"
        );

        assert_eq!(
            db.get_item(&id, 0).unwrap().unwrap().state,
            "quarantined",
            "the sender records the receiver's verdict, in the shared vocabulary"
        );
    }

    /// The blind re-send is skipped for a quarantine: the bytes are identical
    /// on a second attempt, so the hash verdict is identical too. ONE dial.
    #[tokio::test]
    async fn a_quarantine_never_re_dials_or_re_sends_the_payload() {
        let db = Arc::new(Db::open_in_memory().unwrap());
        db.migrate().unwrap();
        let root = tempfile::tempdir().unwrap();
        let staging = Arc::new(Staging::new(root.path().to_path_buf()));
        let id = enqueued_file(&db, &staging);

        let (sessions, connects) = stub_peer_registry(false, 0);
        drain_one(&db, &staging, sessions, id).await;
        assert_eq!(
            connects.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "a hash mismatch is permanent; re-sending the same bytes cannot help"
        );
    }

    /// B4 fail-closed: a clean ack still delivers exactly as before.
    #[tokio::test]
    async fn a_clean_ack_still_marks_the_row_done() {
        let db = Arc::new(Db::open_in_memory().unwrap());
        db.migrate().unwrap();
        let root = tempfile::tempdir().unwrap();
        let staging = Arc::new(Staging::new(root.path().to_path_buf()));
        let id = enqueued_file(&db, &staging);

        let (sessions, connects) = stub_peer_registry(true, 0);
        drain_one(&db, &staging, sessions, id).await;
        assert_eq!(db.get_outbox(&id).unwrap().unwrap().state, "done");
        assert_eq!(
            db.get_transfer(&id).unwrap().unwrap().state,
            "done",
            "the transfers row follows a delivered share (B2/F4)"
        );
        assert_eq!(connects.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    /// B4 fail-closed: a GENUINE transport failure must still retry, still
    /// back off, and still count the attempt. Quarantine must not have
    /// narrowed the retry path for real errors.
    #[tokio::test]
    async fn an_unreachable_peer_still_backs_off_and_retries() {
        let db = Arc::new(Db::open_in_memory().unwrap());
        db.migrate().unwrap();
        let root = tempfile::tempdir().unwrap();
        let staging = Arc::new(Staging::new(root.path().to_path_buf()));
        let id = enqueued_file(&db, &staging);

        // A connect closure that cannot reach the peer: the transport failure
        // path, entirely distinct from a hash verdict.
        let sessions: SharedSessions<crate::net::secure::MemConn> =
            Arc::new(Mutex::new(SessionRegistry::new(
                std::time::Duration::from_secs(30),
                Box::new(
                    |_p: [u8; 16]| -> crate::session::BoxFutureConn<crate::net::secure::MemConn> {
                        Box::pin(async {
                            Err(CoreError::Io(std::io::Error::new(
                                std::io::ErrorKind::ConnectionRefused,
                                "peer gone",
                            )))
                        })
                    },
                ) as crate::session::BoxConnect<crate::net::secure::MemConn>,
            )));

        drain_one(&db, &staging, sessions, id).await;
        let row = db.get_outbox(&id).unwrap().unwrap();
        assert_eq!(
            row.state, "pending",
            "a real transport failure backs off and retries"
        );
        assert_eq!(row.attempts, 1, "and it counts the attempt");
        assert_eq!(
            db.get_transfer(&id).unwrap().unwrap().state,
            "paused",
            "still retrying, not failed"
        );
        assert_eq!(
            db.get_item(&id, 0).unwrap(),
            None,
            "a transport failure quarantines nothing, and invents no item row"
        );
    }

    /// The receiver reports only the FIRST failed item and AckMsg has room for
    /// exactly one index, so a manifest with three items can hide two more
    /// quarantines. The sender must record ONLY the index it was told about:
    /// marking the others would be a guess, and a guess here writes
    /// 'quarantined' onto files the receiver may well have accepted.
    #[tokio::test]
    async fn only_the_item_the_ack_names_is_marked_quarantined() {
        let db = Arc::new(Db::open_in_memory().unwrap());
        db.migrate().unwrap();
        let root = tempfile::tempdir().unwrap();
        let staging = Arc::new(Staging::new(root.path().to_path_buf()));

        let src = tempfile::tempdir().unwrap();
        let mut files = Vec::new();
        let mut items = Vec::new();
        for i in 0..3u32 {
            let f = src.path().join(format!("{i}.bin"));
            std::fs::write(&f, b"data").unwrap();
            items.push(
                crate::manifest::Item::from_file(i, &f, crate::manifest::CHUNK_SIZE_DEFAULT)
                    .unwrap(),
            );
            files.push(f);
        }
        let manifest = Manifest::batch(
            crate::manifest::DeviceRef {
                device_id: [9u8; 16],
                name: "local".into(),
            },
            items,
        )
        .unwrap();
        let id = crate::outbox::enqueue(&db, &staging, &[9u8; 16], &manifest, &files).unwrap();

        // The peer quarantines item 1 only, so a non-zero index goes over the
        // wire and the test can prove the sender marks THAT item and no other.
        let (sessions, _connects) = stub_peer_registry(false, 1);

        drain_one(&db, &staging, sessions, id).await;

        assert_eq!(
            db.get_item(&id, 1).unwrap().unwrap().state,
            "quarantined",
            "the named item carries the verdict"
        );
        for idx in [0u32, 2] {
            assert!(
                db.get_item(&id, idx).unwrap().is_none(),
                "item {idx} was never named by the ack, so the sender must not invent a row for it"
            );
        }
        assert_eq!(
            db.get_outbox(&id).unwrap().unwrap().state,
            "failed",
            "the outbox row still settles: the verdict is real even though it is partial"
        );
    }

    /// A connection that dies AFTER the chunks but BEFORE the ack is not a
    /// verdict and cannot be one: the receiver never told us anything. So it
    /// must still take the blind re-dial inside send_secure_with, which is the
    /// fail-closed behaviour B4 must not narrow.
    #[tokio::test]
    async fn a_close_after_the_chunks_still_re_dials_and_retries() {
        let db = Arc::new(Db::open_in_memory().unwrap());
        db.migrate().unwrap();
        let root = tempfile::tempdir().unwrap();
        let staging = Arc::new(Staging::new(root.path().to_path_buf()));
        let id = enqueued_file(&db, &staging);

        let connects = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let c = connects.clone();
        let sessions: SharedSessions<crate::net::secure::MemConn> =
            Arc::new(Mutex::new(SessionRegistry::new(
                std::time::Duration::from_secs(30),
                Box::new(move |_p: [u8; 16]| {
                    let c = c.clone();
                    Box::pin(async move {
                        c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        let (mine, mut theirs) = crate::net::secure::SecureConnection::<
                            crate::net::secure::MemConn,
                        >::test_pair();
                        tokio::spawn(async move {
                            use crate::net::FrameTransport;
                            let mut chunks = 0usize;
                            loop {
                                match theirs.recv().await {
                                    Ok(Some(f)) if f.kind == RecordType::Chunk => chunks += 1,
                                    Ok(Some(_)) => {}
                                    Ok(None) | Err(_) => return,
                                }
                                // All the bytes have arrived; hang up without
                                // an ack, the worst case for the receiver.
                                if chunks > 0 {
                                    return;
                                }
                            }
                        });
                        Ok(mine)
                    })
                        as crate::session::BoxFutureConn<crate::net::secure::MemConn>
                }) as crate::session::BoxConnect<crate::net::secure::MemConn>,
            )));

        drain_one(&db, &staging, sessions, id).await;

        assert_eq!(
            connects.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "a real transport failure still earns the blind re-dial"
        );
        let row = db.get_outbox(&id).unwrap().unwrap();
        assert_eq!(row.state, "pending", "and it is still retryable");
        assert_eq!(row.attempts, 1, "counting exactly one drain attempt");
        assert_eq!(
            db.get_transfer(&id).unwrap().unwrap().state,
            "paused",
            "not failed: the receiver never returned a verdict"
        );
        assert!(
            db.get_item(&id, 0).unwrap().is_none(),
            "no verdict means no item row and nothing quarantined"
        );
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

    /// R-T12-7: set_item_state matches zero rows for an unknown item, so a bare
    /// call would return Ok(()) on garbage. These three cases pin the guards.
    #[test]
    fn retry_item_refuses_garbage_and_rearms_a_real_item() {
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();

        assert!(matches!(
            retry_item_with(&db, [8u8; 16], 0),
            Err(CoreError::Protocol(_))
        ));

        db.upsert_transfer(&crate::store::transfers::TransferRow {
            transfer_id: [1u8; 16],
            payload_id: [2u8; 16],
            peer_device_id: [3u8; 16],
            direction: "in".into(),
            kind: "media".into(),
            state: "done".into(),
            bytes_total: 10,
            bytes_done: 10,
            item_count: 1,
            created_at: 1,
            updated_at: 1,
            manifest: vec![],
            error: None,
        })
        .unwrap();

        assert!(matches!(
            retry_item_with(&db, [1u8; 16], 5),
            Err(CoreError::Protocol(_))
        ));

        db.upsert_item(&crate::store::transfers::ItemRow {
            transfer_id: [1u8; 16],
            item_index: 5,
            item_type: "document".into(),
            name: Some("a.bin".into()),
            mime: None,
            size: Some(10),
            hash: None,
            dest_path: None,
            state: "quarantined".into(),
        })
        .unwrap();

        assert_eq!(
            retry_item_with(&db, [1u8; 16], 5).unwrap(),
            Some([3u8; 16]),
            "the transfer's peer is who to poke"
        );
        assert_eq!(
            db.get_item(&[1u8; 16], 5).unwrap().unwrap().state,
            "pending"
        );
    }
}
