use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use bytes::Bytes;
use tokio::sync::{broadcast, mpsc, Mutex};

use crate::control::Hello;
use crate::crypto::identity::Identity;
use crate::discovery::{
    Advertiser, Browser, PeerAnnounce, Presence, PresenceSocket, PresenceState,
};
use crate::error::{ensure_compatible, CoreError, Result};
use crate::framing::RecordType;
use crate::manifest::Manifest;
use crate::net::secure::{recv_secure_transfer, send_secure_transfer};
use crate::net::tcp;
use crate::net::Connection;
use crate::pairing::PairingBundle;
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
    pending_pairing: Arc<Mutex<Option<PairingBundle>>>,
    pairing_rx: Mutex<mpsc::Receiver<String>>,
}

impl Engine {
    pub async fn start(cfg: EngineConfig) -> Result<Self> {
        let (tx, _rx) = broadcast::channel(256);
        let devices = Arc::new(Mutex::new(HashMap::new()));
        let mut session_id = [0u8; 16];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut session_id);

        let identity = Arc::new(cfg.identity);
        let device_id = identity.device_id();
        let db = cfg.db;
        let display_name = cfg.display_name.clone();
        let out_dir = cfg.out_dir.clone();

        let (listener, local_addr) = tcp::bind(cfg.listen_addr).await?;
        let advertiser = Advertiser::start(&display_name, local_addr.port(), device_id)?;
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

        let accept_task = {
            let identity = identity.clone();
            let db = db.clone();
            let display_name = display_name.clone();
            let out_dir = out_dir.clone();
            let pending_pairing = pending_pairing.clone();
            let pairing_tx = pairing_tx.clone();
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
                    let pairing_tx = pairing_tx.clone();
                    set.spawn(async move {
                        if let Err(e) = Self::handle_inbound(
                            &identity,
                            &db,
                            &out_dir,
                            &display_name,
                            &pending_pairing,
                            &pairing_tx,
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
                }
            })
        };

        let presence_task = {
            let tx = tx.clone();
            let me = device_id;
            match presence.clone() {
                Some(presence) => tokio::spawn(async move {
                    while let Ok((_from, p)) = presence.recv().await {
                        if p.device_id != me {
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
            pending_pairing,
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

    pub async fn offer_pairing(&self, peer: PairingBundle) -> Result<()> {
        *self.pending_pairing.lock().await = Some(peer);
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
        let (pairing, sas) =
            crate::pairing::pair(&mut conn, self.identity.as_ref(), &local, &peer, true).await?;
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
        let transfer_id = manifest.payload_id;
        let pairing = self
            .db
            .get_pairing(&peer_device_id)?
            .ok_or_else(|| CoreError::Protocol("peer is not paired".into()))?;
        let static_secret = zeroize::Zeroizing::new(self.identity.static_secret().to_bytes());
        let mut conn = tcp::dial(addr).await?;
        send_secure_transfer(
            &mut conn,
            &static_secret,
            &pairing.static_dh_pub,
            self.identity.device_id(),
            &manifest,
            &paths,
        )
        .await?;
        Ok(transfer_id)
    }

    /// Called by the accept loop for every inbound connection.
    pub(crate) async fn handle_inbound(
        identity: &Identity,
        db: &Db,
        out_dir: &Path,
        display_name: &str,
        pending_pairing: &Mutex<Option<PairingBundle>>,
        pairing_tx: &mpsc::Sender<String>,
        conn: &mut Connection<tokio::net::TcpStream>,
    ) -> Result<()> {
        let hello = read_hello(conn).await?;
        let local = PairingBundle::new(identity.public(), display_name.to_string());
        if let Some(expected) = pending_pairing.lock().await.take() {
            if hello.device_id != expected.identity.device_id {
                return Err(CoreError::Protocol("pairing hello device mismatch".into()));
            }
            let (pairing, sas) =
                crate::pairing::pair(conn, identity, &local, &expected, false).await?;
            db.upsert_pairing(&pairing)?;
            let _ = pairing_tx.send(sas).await;
            return Ok(());
        }
        let pairing = db
            .get_pairing(&hello.device_id)?
            .ok_or_else(|| CoreError::Protocol("unpaired inbound connection".into()))?;
        let static_secret = zeroize::Zeroizing::new(identity.static_secret().to_bytes());
        recv_secure_transfer(conn, &static_secret, &pairing.static_dh_pub, out_dir).await?;
        Ok(())
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
}
