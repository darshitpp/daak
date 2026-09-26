use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use rand::Rng;

use crate::error::{CoreError, Result};

use super::naming::resolve_name;

pub const SERVICE_TYPE: &str = "_daak._tcp.local.";
pub const PROTO_VERSION: u16 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerAnnounce {
    pub device_id: [u8; 16],
    pub name: String,
    pub addr: SocketAddr,
    pub port: u16,
    pub proto_version: u16,
    pub capabilities: u32,
    pub status: String,
}

pub struct Advertiser {
    daemon: ServiceDaemon,
    fullname: String,
}

impl Advertiser {
    pub fn start(name: &str, port: u16, device_id: [u8; 16]) -> Result<Self> {
        Self::start_with_meta(name, port, device_id, "", "", 0, "online")
    }

    pub fn start_with_meta(
        name: &str,
        port: u16,
        device_id: [u8; 16],
        fp: &str,
        pk: &str,
        caps: u32,
        status: &str,
    ) -> Result<Self> {
        let daemon = ServiceDaemon::new().map_err(|e| CoreError::Discovery(e.to_string()))?;
        let mut props = HashMap::new();
        props.insert("id".to_string(), hex::encode(device_id));
        props.insert("name".to_string(), name.to_string());
        props.insert("v".to_string(), PROTO_VERSION.to_string());
        if let Some(fp) = txt_short(fp, 20) {
            props.insert("fp".to_string(), fp);
        }
        if let Some(pk) = txt_short(pk, 16) {
            props.insert("pk".to_string(), pk);
        }
        props.insert("caps".to_string(), caps.to_string());
        props.insert("st".to_string(), status.to_string());
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

    /// Advertise under `base_name`, unless a peer already claims it. Browses the
    /// service type for `BROWSE_WINDOW`, then picks the final name from the
    /// observed peer names via the pure [`resolve_name`]. Re-browses briefly
    /// afterwards: mdns_sd does not report a name conflict, so the only way to
    /// see a peer that booted inside our first window is to look again and
    /// re-register under a different name. The decision itself stays pure.
    pub fn start_resolving(
        base_name: &str,
        port: u16,
        device_id: [u8; 16],
        rng: &mut impl Rng,
    ) -> Result<(Self, String)> {
        let mut observed = browse_observed_names(BROWSE_WINDOW).unwrap_or_default();
        let mut name = resolve_name(base_name, &observed, rng);
        for _ in 0..2 {
            let adv = Self::start(&name, port, device_id)?;
            let late = browse_observed_names(RECHECK_WINDOW).unwrap_or_default();
            if !late.iter().any(|n| n == &name) {
                return Ok((adv, name));
            }
            adv.stop();
            observed.extend(late);
            name = resolve_name(base_name, &observed, rng);
        }
        Ok((Self::start(&name, port, device_id)?, name))
    }
}

/// How long to re-browse after registering, to catch a peer that appeared
/// during the initial window and took the same name.
pub const RECHECK_WINDOW: std::time::Duration = std::time::Duration::from_millis(150);

/// How long to browse for a same-named peer before committing to a name.
pub const BROWSE_WINDOW: std::time::Duration = std::time::Duration::from_millis(500);

/// Peer names seen on the LAN in `window`, excluding our own service. Best
/// effort: a browse that cannot start yields an empty list, so a machine with no
/// working mDNS keeps its base name instead of failing to start.
fn browse_observed_names(window: std::time::Duration) -> Result<Vec<String>> {
    let browser = Browser::start()?;
    let deadline = std::time::Instant::now() + window;
    let mut names = Vec::new();
    while std::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        match browser.rx.recv_timeout(remaining) {
            Ok(ServiceEvent::ServiceResolved(info)) => {
                if let Ok(a) = announce_from_service(&info) {
                    if !names.contains(&a.name) {
                        names.push(a.name);
                    }
                }
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    browser.stop();
    Ok(names)
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
    let capabilities = props
        .get_property_val_str("caps")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let status = props
        .get_property_val_str("st")
        .unwrap_or("unknown")
        .to_string();
    let addr = pick_addr(info.get_addresses().iter().copied(), info.get_port())
        .ok_or_else(|| CoreError::Discovery("service has no address yet".into()))?;
    Ok(PeerAnnounce {
        device_id,
        name,
        addr,
        port: info.get_port(),
        proto_version,
        capabilities,
        status,
    })
}

pub fn pick_addr(addrs: impl Iterator<Item = IpAddr>, port: u16) -> Option<SocketAddr> {
    fn rank(ip: IpAddr) -> u8 {
        match ip {
            IpAddr::V4(v4) if v4.is_private() => 0,
            IpAddr::V4(v4) if v4.is_loopback() || v4.is_link_local() => 1,
            IpAddr::V6(v6) if (v6.segments()[0] & 0xffc0) == 0xfe80 => 2,
            _ => 3,
        }
    }
    addrs
        .min_by_key(|ip| (rank(*ip), *ip))
        .map(|ip| SocketAddr::new(ip, port))
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

fn txt_short(value: &str, max_chars: usize) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value.chars().take(max_chars).collect())
    }
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

    #[test]
    fn pick_addr_prefers_private_ipv4_regardless_of_order() {
        let mixed: Vec<IpAddr> = vec![
            "8.8.8.8".parse().unwrap(),
            "fe80::1".parse().unwrap(),
            "192.168.1.20".parse().unwrap(),
            "127.0.0.1".parse().unwrap(),
        ];
        let chosen = pick_addr(mixed.iter().copied(), 40001).unwrap();
        assert_eq!(chosen.ip(), "192.168.1.20".parse::<IpAddr>().unwrap());

        let reversed: Vec<IpAddr> = mixed.into_iter().rev().collect();
        let chosen_rev = pick_addr(reversed.iter().copied(), 40001).unwrap();
        assert_eq!(chosen_rev.ip(), "192.168.1.20".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn parses_capability_and_status_txt_records() {
        let mut props = HashMap::new();
        props.insert("id".into(), "0102030405060708090a0b0c0d0e0f10".into());
        props.insert("v".into(), "1".into());
        props.insert("name".into(), "Peer".into());
        props.insert("caps".into(), "5".into());
        props.insert("st".into(), "online".into());
        let info = mdns_sd::ServiceInfo::new(
            SERVICE_TYPE,
            "peer",
            "peer.local.",
            "192.168.1.30",
            40001,
            props,
        )
        .unwrap();
        let a = announce_from_service(&info).unwrap();
        assert_eq!(a.capabilities, 5);
        assert_eq!(a.status, "online");
    }

    #[test]
    fn older_peer_without_caps_defaults_to_zero() {
        let mut props = HashMap::new();
        props.insert("id".into(), "0102030405060708090a0b0c0d0e0f10".into());
        let info = mdns_sd::ServiceInfo::new(
            SERVICE_TYPE,
            "old",
            "old.local.",
            "192.168.1.31",
            40002,
            props,
        )
        .unwrap();
        let a = announce_from_service(&info).unwrap();
        assert_eq!(a.capabilities, 0);
        assert_eq!(a.status, "unknown");
    }

    #[test]
    fn txt_short_omits_empty_and_truncates_by_chars() {
        assert_eq!(txt_short("", 20), None);
        let long = "abcdefghijklmnopqrstuvwxyz0123";
        assert_eq!(txt_short(long, 20).unwrap().chars().count(), 20);
        assert_eq!(txt_short(long, 16).unwrap().chars().count(), 16);
        let multi = "é".repeat(30);
        assert_eq!(txt_short(&multi, 20).unwrap().chars().count(), 20);
        assert_eq!(txt_short(&multi, 16).unwrap().chars().count(), 16);
    }
}
