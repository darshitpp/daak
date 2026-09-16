use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::{broadcast, Mutex};

use crate::discovery::{
    Advertiser, Browser, PeerAnnounce, Presence, PresenceSocket, PresenceState,
};
use crate::error::Result;
use crate::manifest::Manifest;
use crate::net::tcp;
use crate::transfer::{receive_transfer, send_transfer};

/// A rejected peer is a per-connection event; anything else is a listener fault.
fn accept_error_is_fatal(err: &crate::error::CoreError) -> bool {
    !matches!(err, crate::error::CoreError::Protocol(_))
}

#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub display_name: String,
    pub device_id: [u8; 16],
    pub listen_addr: SocketAddr,
    pub out_dir: PathBuf,
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
    presence: Option<Arc<PresenceSocket>>,
    accept_task: tokio::task::JoinHandle<()>,
    discovery_task: tokio::task::JoinHandle<()>,
    presence_task: tokio::task::JoinHandle<()>,
}

impl Engine {
    pub async fn start(cfg: EngineConfig) -> Result<Self> {
        let (tx, _rx) = broadcast::channel(256);
        let devices = Arc::new(Mutex::new(HashMap::new()));

        let (listener, local_addr) = tcp::bind(cfg.listen_addr).await?;
        let advertiser = Advertiser::start(&cfg.display_name, local_addr.port(), cfg.device_id)?;
        let browser = Arc::new(Browser::start()?);
        let presence = match PresenceSocket::bind().await {
            Ok(p) => {
                let p = Arc::new(p);
                // Best-effort: presence is an enhancement, not required for transfer.
                if let Err(e) = p
                    .announce(&Presence::new(
                        cfg.device_id,
                        cfg.display_name.clone(),
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

        let accept_task = {
            let tx = tx.clone();
            let out_dir = cfg.out_dir.clone();
            tokio::spawn(async move {
                // JoinSet aborts any in-flight receivers when it is dropped, and the
                // accept task's locals are dropped when shutdown aborts this task, so
                // shutdown also stops in-flight receive_transfer calls.
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
                    let tx = tx.clone();
                    let out_dir = out_dir.clone();
                    set.spawn(async move {
                        match receive_transfer(&mut conn, &out_dir, |_| {}).await {
                            Ok(m) => {
                                let _ = tx.send(EngineEvent::TransferDone {
                                    transfer_id: m.payload_id,
                                });
                            }
                            Err(e) => {
                                let _ = tx.send(EngineEvent::TransferFailed {
                                    transfer_id: [0u8; 16],
                                    error: e.to_string(),
                                });
                            }
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
            tokio::spawn(async move {
                while let Some(PeerAnnounce {
                    device_id,
                    name,
                    addr,
                    ..
                }) = browser.recv().await
                {
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
            let me = cfg.device_id;
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
            presence,
            accept_task,
            discovery_task,
            presence_task,
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

    pub async fn send_to(
        &self,
        peer: SocketAddr,
        manifest: Manifest,
        paths: Vec<Option<PathBuf>>,
    ) -> Result<[u8; 16]> {
        let transfer_id = manifest.payload_id;
        let total: u64 = manifest.items.iter().filter_map(|i| i.size).sum();
        let tx = self.tx.clone();
        let mut done = 0u64;
        let mut conn = tcp::dial(peer).await?;
        let result = send_transfer(&mut conn, &manifest, &paths, |n| {
            done += n;
            let _ = tx.send(EngineEvent::TransferProgress {
                transfer_id,
                bytes_done: done,
                bytes_total: total,
            });
        })
        .await;
        match result {
            Ok(()) => {
                let _ = tx.send(EngineEvent::TransferDone { transfer_id });
                Ok(transfer_id)
            }
            Err(e) => {
                let _ = tx.send(EngineEvent::TransferFailed {
                    transfer_id,
                    error: e.to_string(),
                });
                Err(e)
            }
        }
    }

    pub async fn shutdown(self) -> Result<()> {
        self.accept_task.abort();
        self.discovery_task.abort();
        self.presence_task.abort();
        self.advertiser.stop();
        self.browser.stop();
        let _ = self.presence;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{DeviceRef, Item, PayloadKind};

    #[tokio::test]
    async fn end_to_end_transfer_between_two_engines() {
        let recv_dir = tempfile::tempdir().unwrap();
        let src_dir = tempfile::tempdir().unwrap();

        let receiver = Engine::start(EngineConfig {
            display_name: "receiver".into(),
            device_id: [2u8; 16],
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            out_dir: recv_dir.path().to_path_buf(),
        })
        .await
        .unwrap();

        let sender = Engine::start(EngineConfig {
            display_name: "sender".into(),
            device_id: [1u8; 16],
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            out_dir: src_dir.path().to_path_buf(),
        })
        .await
        .unwrap();

        let path = src_dir.path().join("note.txt.bin");
        std::fs::write(&path, b"daak integration payload").unwrap();
        let item = Item::from_file(0, &path, 64 * 1024).unwrap();
        let manifest = Manifest::new(
            PayloadKind::Media,
            DeviceRef {
                device_id: [1u8; 16],
                name: "sender".into(),
            },
            vec![item],
        );

        let mut events = sender.events();
        let transfer_id = sender
            .send_to(receiver.local_addr(), manifest, vec![Some(path.clone())])
            .await
            .unwrap();

        let mut saw_done = false;
        for _ in 0..20 {
            match tokio::time::timeout(std::time::Duration::from_secs(1), events.recv()).await {
                Ok(Ok(EngineEvent::TransferDone { transfer_id: id })) if id == transfer_id => {
                    saw_done = true;
                    break;
                }
                Ok(Ok(_)) => continue,
                _ => break,
            }
        }
        assert!(saw_done, "sender never reported TransferDone");
        assert_eq!(
            std::fs::read(recv_dir.path().join("note.txt.bin")).unwrap(),
            b"daak integration payload"
        );

        sender.shutdown().await.unwrap();
        receiver.shutdown().await.unwrap();
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
}
