use std::collections::HashMap;
use std::net::SocketAddr;

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};

use crate::error::{CoreError, Result};

pub const SERVICE_TYPE: &str = "_daak._tcp.local.";
pub const PROTO_VERSION: u16 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerAnnounce {
    pub device_id: [u8; 16],
    pub name: String,
    pub addr: SocketAddr,
    pub port: u16,
    pub proto_version: u16,
}

pub struct Advertiser {
    daemon: ServiceDaemon,
    fullname: String,
}

impl Advertiser {
    pub fn start(name: &str, port: u16, device_id: [u8; 16]) -> Result<Self> {
        let daemon = ServiceDaemon::new().map_err(|e| CoreError::Discovery(e.to_string()))?;
        let mut props = HashMap::new();
        props.insert("id".to_string(), hex::encode(device_id));
        props.insert("name".to_string(), name.to_string());
        props.insert("v".to_string(), PROTO_VERSION.to_string());
        let host = format!("{}.local.", sanitize_host(name));
        let info = ServiceInfo::new(SERVICE_TYPE, &sanitize_host(name), &host, "", port, props)
            .map_err(|e| CoreError::Discovery(e.to_string()))?
            .enable_addr_auto();
        let fullname = info.get_fullname().to_string();
        daemon
            .register(info)
            .map_err(|e| CoreError::Discovery(e.to_string()))?;
        Ok(Self { daemon, fullname })
    }

    pub fn stop(&self) {
        let _ = self.daemon.unregister(&self.fullname);
        let _ = self.daemon.shutdown();
    }
}

pub struct Browser {
    daemon: ServiceDaemon,
    rx: mdns_sd::Receiver<ServiceEvent>,
}

impl Browser {
    pub fn start() -> Result<Self> {
        let daemon = ServiceDaemon::new().map_err(|e| CoreError::Discovery(e.to_string()))?;
        let rx = daemon
            .browse(SERVICE_TYPE)
            .map_err(|e| CoreError::Discovery(e.to_string()))?;
        Ok(Self { daemon, rx })
    }

    pub async fn recv(&self) -> Option<PeerAnnounce> {
        loop {
            let event = self.rx.recv_async().await.ok()?;
            if let ServiceEvent::ServiceResolved(info) = event {
                if let Ok(a) = announce_from_service(&info) {
                    return Some(a);
                }
            }
        }
    }

    pub fn stop(&self) {
        let _ = self.daemon.shutdown();
    }
}

pub fn announce_from_service(info: &ServiceInfo) -> Result<PeerAnnounce> {
    let props = info.get_properties();
    let id_hex = props
        .get_property_val_str("id")
        .ok_or_else(|| CoreError::Discovery("service missing 'id' txt".into()))?;
    let bytes = hex::decode(id_hex).map_err(|e| CoreError::Discovery(e.to_string()))?;
    let device_id: [u8; 16] = bytes
        .try_into()
        .map_err(|_| CoreError::Discovery("device id must be 16 bytes".into()))?;
    let name = props
        .get_property_val_str("name")
        .unwrap_or_else(|| info.get_hostname())
        .to_string();
    let proto_version = props
        .get_property_val_str("v")
        .and_then(|v| v.parse().ok())
        .unwrap_or(PROTO_VERSION);
    let addr = info
        .get_addresses()
        .iter()
        .next()
        .map(|ip| SocketAddr::new(*ip, info.get_port()))
        .ok_or_else(|| CoreError::Discovery("service has no address yet".into()))?;
    Ok(PeerAnnounce {
        device_id,
        name,
        addr,
        port: info.get_port(),
        proto_version,
    })
}

fn sanitize_host(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn maps_service_info_to_peer_announce() {
        let mut props = HashMap::new();
        props.insert(
            "id".to_string(),
            "0102030405060708090a0b0c0d0e0f10".to_string(),
        );
        props.insert("v".to_string(), "1".to_string());
        props.insert("name".to_string(), "Seawood Otter".to_string());
        let info = mdns_sd::ServiceInfo::new(
            SERVICE_TYPE,
            "seawood-otter",
            "seawood-otter.local.",
            "192.168.1.20",
            40001,
            props,
        )
        .unwrap();

        let a = announce_from_service(&info).unwrap();
        assert_eq!(
            a.device_id,
            [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
        );
        assert_eq!(a.name, "Seawood Otter");
        assert_eq!(a.port, 40001);
        assert_eq!(a.proto_version, 1);
    }

    #[test]
    fn rejects_service_info_without_device_id() {
        let info = mdns_sd::ServiceInfo::new(
            SERVICE_TYPE,
            "x",
            "x.local.",
            "192.168.1.21",
            40001,
            std::collections::HashMap::<String, String>::new(),
        )
        .unwrap();
        assert!(announce_from_service(&info).is_err());
    }
}
