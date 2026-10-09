use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use rand::Rng;

use crate::error::{CoreError, Result};

use super::naming::resolve_name;
use super::records::{DiscoveryEvent, RecordTracker};

pub const SERVICE_TYPE: &str = "_daak._tcp.local.";
/// The wire protocol version. The major part is `PROTO_VERSION / 100`.
/// Major 1: the session keys come from the secret Noise `split()` output.
/// Major 0 (value 1) derived them from the public handshake hash.
pub const PROTO_VERSION: u16 = 100;

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

/// The `bind_ip` an engine should advertise for a listener bound to `ip`.
///
/// THE shared rule, used by every call site: a WILDCARD bind means "listen on
/// every interface", which is what all three shipped entry points request
/// (`0.0.0.0:{port}` in daakd, daak-ffi and daak-cli) and what `tcp::bind`
/// reports back. That is not an address any peer can dial, and publishing it
/// verbatim with `addr_auto` off is strictly worse than publishing nothing:
/// `pick_addr` does not filter the unspecified address, so a browsing peer
/// resolves `0.0.0.0:<port>` and the dial is refused as non-local. So an
/// unspecified IP maps to `None`, which keeps the auto form -- the daemon
/// fills the record with the host's real interface addresses, and refills it
/// when an interface changes.
///
/// Only an EXPLICIT interface becomes `Some`, and that is the case `Some` is
/// for: the record then carries exactly the address the listener is on, so no
/// later announce can move a peer's send to an interface nothing listens on.
/// One function, both call sites, so `Engine::start` and
/// `Engine::set_display_name` cannot drift apart.
pub(crate) fn advertise_ip(ip: IpAddr) -> Option<IpAddr> {
    (!ip.is_unspecified()).then_some(ip)
}

/// Interface names that are NOT the LAN.
///
/// A VPN (utun), a point-to-point tunnel (ppp, tun, tap), Apple Wireless Direct
/// Link (awdl, llw) and the loopback all carry an address a peer on the LAN
/// cannot dial. Worse, a VPN's address often SORTS FIRST in [pick_addr]:
/// rank prefers a private IPv4 and then the numerically smallest one, so a
/// VPN's 10.7.0.1 beats the real LAN's 192.168.0.226. That is the measured
/// case: with a VPN connected, this device advertised the tunnel address and
/// every peer dialled it and hung.
fn is_lan_interface(name: &str) -> bool {
    !(name.starts_with("utun")
        || name.starts_with("ipsec")
        || name.starts_with("ppp")
        || name.starts_with("tun")
        || name.starts_with("tap")
        || name.starts_with("awdl")
        || name.starts_with("llw")
        || name.starts_with("lo"))
}

/// The address OUR mDNS record should publish, for a listener bound to bound.
///
/// A specific bind publishes itself. A WILDCARD bind is the shipped case, and
/// [advertise_ip] alone turns it into None, which enables the daemon's auto
/// form and publishes EVERY interface address -- including a VPN's. A browsing
/// peer then runs [pick_addr] over that list and can choose the tunnel. So the
/// wildcard case resolves the ONE interface address a peer on this LAN can
/// dial, and publishes exactly that.
pub(crate) fn advertise_bind_ip(bound: SocketAddr) -> Option<IpAddr> {
    if let Some(ip) = advertise_ip(bound.ip()) {
        return Some(ip);
    }
    host_lan_addr(bound.port()).map(|a| a.ip())
}

impl Advertiser {
    pub fn start(name: &str, port: u16, device_id: [u8; 16]) -> Result<Self> {
        Self::start_with_meta(name, port, device_id, "", "", 0, "online", None)
    }

    /// Register one advertisement.
    ///
    /// `bind_ip` is the address this process actually listens on. `Some(ip)`
    /// publishes EXACTLY that address with `addr_auto` off; `None` enables
    /// `addr_auto`, which fills the record with the host's interface addresses
    /// (and refills it on every interface change). A wildcard bind MUST be
    /// passed as `None`: publishing the literal `0.0.0.0` is worse than either
    /// alternative, because a peer reads it as an address to dial and the dial
    /// is refused. See [`Self::service_info`].
    #[allow(clippy::too_many_arguments)]
    pub fn start_with_meta(
        name: &str,
        port: u16,
        device_id: [u8; 16],
        fp: &str,
        pk: &str,
        caps: u32,
        status: &str,
        bind_ip: Option<IpAddr>,
    ) -> Result<Self> {
        let daemon = new_daemon()?;
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
        let info = Self::service_info(name, port, props, bind_ip)?;
        let fullname = info.get_fullname().to_string();
        daemon
            .register(info)
            .map_err(|e| CoreError::Discovery(e.to_string()))?;
        Ok(Self { daemon, fullname })
    }

    /// Build the record [`Self::start_with_meta`] registers.
    ///
    /// Split out from the registration so the address contract is testable
    /// directly: `ServiceDaemon` exposes no way to read a registered record
    /// back, so a test of this can only assert on what was built. `props` is
    /// the TXT map the caller assembled (`id`, `name`, `v`, `fp`, `pk`, `caps`,
    /// `st`); this adds only the address and the port.
    ///
    /// The `Some` arm publishes one address and leaves `addr_auto` off, so no
    /// later interface event can move the record off it. The `None` arm is the
    /// auto form: the record starts EMPTY and the daemon fills it with the
    /// host's interface addresses, and refills it when an interface changes.
    ///
    /// A WILDCARD bind must arrive here as `None`, never as `Some(0.0.0.0)`.
    /// `tcp::bind` reports the requested address back, and every shipped entry
    /// point requests `0.0.0.0`; `Some` would write that literal into the A
    /// record with auto off, so a browsing peer's `pick_addr` would hand back
    /// `0.0.0.0:<port>` -- an address `is_local` rejects, so the send path
    /// hard-fails with "refusing non-local address". The engine normalises the
    /// wildcard back to `None` at every call site (see `discovery::advertise_ip`).
    fn service_info(
        name: &str,
        port: u16,
        props: HashMap<String, String>,
        bind_ip: Option<IpAddr>,
    ) -> Result<ServiceInfo> {
        let host = format!("{}.local.", sanitize_host(name));
        let info = match bind_ip {
            Some(ip) => {
                ServiceInfo::new(SERVICE_TYPE, &sanitize_host(name), &host, ip, port, props)
            }
            None => ServiceInfo::new(SERVICE_TYPE, &sanitize_host(name), &host, "", port, props)
                .map(|i| i.enable_addr_auto()),
        }
        .map_err(|e| CoreError::Discovery(e.to_string()))?;
        Ok(info)
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
        Self::start_resolving_on(base_name, port, device_id, rng, None)
    }

    /// [`Self::start_resolving`] with the bind IP threaded through to the
    /// winning registration. Every registration inside the resolve loop must
    /// advertise the same address the final record does, otherwise a rejected
    /// candidate leaves a peer resolving to the wrong interface.
    ///
    /// `bind_ip` follows [`Self::service_info`]: `None` for a wildcard bind
    /// (the production path), `Some(ip)` only for a real explicit interface.
    pub fn start_resolving_on(
        base_name: &str,
        port: u16,
        device_id: [u8; 16],
        rng: &mut impl Rng,
        bind_ip: Option<IpAddr>,
    ) -> Result<(Self, String)> {
        let mut observed =
            browse_observed_names(BROWSE_WINDOW, Some(device_id)).unwrap_or_default();
        let mut name = resolve_name(base_name, &observed, rng);
        for _ in 0..2 {
            let adv = Self::start_with_meta(&name, port, device_id, "", "", 0, "online", bind_ip)?;
            // R45c. Some(device_id), not None. A browse on this host DOES see our
            // own freshly registered record, so an unfiltered recheck always found
            // the chosen name, the guard was always false, and every free name came
            // back as Adjective Animal. A real peer keeps a DIFFERENT device id, so
            // the filter removes a self-match and keeps the guard against a peer.
            let late = browse_observed_names(RECHECK_WINDOW, Some(device_id)).unwrap_or_default();
            if !late.iter().any(|n| n == &name) {
                return Ok((adv, name));
            }
            adv.stop();
            observed.extend(late);
            name = resolve_name(base_name, &observed, rng);
        }
        Ok((
            Self::start_with_meta(&name, port, device_id, "", "", 0, "online", bind_ip)?,
            name,
        ))
    }
}

/// How long to re-browse after registering, to catch a peer that appeared
/// during the initial window and took the same name.
pub const RECHECK_WINDOW: std::time::Duration = std::time::Duration::from_millis(150);

/// How long to browse for a same-named peer before committing to a name.
pub const BROWSE_WINDOW: std::time::Duration = std::time::Duration::from_millis(500);

/// Peer names seen on the LAN in `window`, minus our own service. Best effort: a
/// browse that cannot start yields an empty list, so a machine with no working
/// mDNS keeps its base name instead of failing to start.
///
/// R45c. This collects records and hands them to [`observed_names_from_records`],
/// the ONE collision-set function. The tests call that function too, so there is
/// one implementation and no copy that can drift.
fn browse_observed_names(
    window: std::time::Duration,
    local_device_id: Option<[u8; 16]>,
) -> Result<Vec<String>> {
    let browser = Browser::start()?;
    let deadline = std::time::Instant::now() + window;
    let mut records = Vec::new();
    while std::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        match browser.rx.recv_timeout(remaining) {
            Ok(ServiceEvent::ServiceResolved(info)) => records.push(info),
            Ok(_) => {}
            Err(_) => break,
        }
    }
    browser.stop();
    Ok(observed_names_from_records(&records, local_device_id))
}

/// The collision set from resolved records, minus our own record. THE ONE place
/// a name is added to a collision set. [`browse_observed_names`] calls it and the
/// tests call it, so the filter cannot be changed on one path only.
///
/// R45c. A rename replaces our own registration, but the OLD record stays on the
/// LAN for the length of the window. Before this filter the browse read that old
/// record as a collision with itself, and the recheck read our own FRESH record
/// the same way, so the name the user typed never appeared.
///
/// `local_device_id` is `Some` at both call sites in [`Advertiser::start_resolving_on`].
/// `None` is kept for a caller that wants no filtering at all.
fn observed_names_from_records(
    records: &[ServiceInfo],
    local_device_id: Option<[u8; 16]>,
) -> Vec<String> {
    let mut names = Vec::new();
    for info in records {
        if is_own_advertisement(announced_device_id(info), local_device_id) {
            continue;
        }
        let name = announced_name(info);
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

/// The 16 byte device id a resolved record announces, or None when the record
/// carries no usable id. A record with no id is not provably ours, so the filter
/// below keeps it.
fn announced_device_id(info: &ServiceInfo) -> Option<[u8; 16]> {
    let hex_id = info.get_properties().get_property_val_str("id")?;
    let bytes = hex::decode(hex_id).ok()?;
    bytes.try_into().ok()
}

/// The advertised name of a resolved record, falling back to the hostname.
fn announced_name(info: &ServiceInfo) -> String {
    let props = info.get_properties();
    props
        .get_property_val_str("name")
        .unwrap_or_else(|| info.get_hostname())
        .to_string()
}

/// Must this announcement be dropped from the collision set?
///
/// R45c. Both browse call sites pass `Some(local_device_id)`. The filter removes a
/// SELF-MATCH. It does not remove the guard against a real peer, because a real
/// peer announces a DIFFERENT device id.
///
/// A record that announces no id is kept. Dropping it would let an unnamed
/// service claim our name unchecked, which is the worse failure.
pub(crate) fn is_own_advertisement(
    announced: Option<[u8; 16]>,
    local_device_id: Option<[u8; 16]>,
) -> bool {
    match (announced, local_device_id) {
        (Some(announced_id), Some(local_id)) => announced_id == local_id,
        _ => false,
    }
}

/// Start one `mdns-sd` daemon.
///
/// In a unit test build, the daemon has no enabled interface.
/// `mdns-sd` 0.11.5 never lists a loopback interface, so no loopback-only
/// setting exists. Zero interfaces is the nearest setting.
/// A unit test then cannot advertise a fake peer on the real LAN.
fn new_daemon() -> Result<ServiceDaemon> {
    let daemon = ServiceDaemon::new().map_err(|e| CoreError::Discovery(e.to_string()))?;
    #[cfg(test)]
    {
        daemon
            .disable_interface(mdns_sd::IfKind::All)
            .map_err(|e| CoreError::Discovery(e.to_string()))?;
    }
    Ok(daemon)
}

pub struct Browser {
    daemon: ServiceDaemon,
    rx: mdns_sd::Receiver<ServiceEvent>,
    tracker: std::sync::Mutex<RecordTracker>,
}

impl Browser {
    pub fn start() -> Result<Self> {
        let daemon = new_daemon()?;
        let rx = daemon
            .browse(SERVICE_TYPE)
            .map_err(|e| CoreError::Discovery(e.to_string()))?;
        Ok(Self {
            daemon,
            rx,
            tracker: std::sync::Mutex::default(),
        })
    }

    /// The next found or lost device. `None` after `stop`.
    pub async fn recv(&self) -> Option<DiscoveryEvent> {
        loop {
            let event = self.rx.recv_async().await.ok()?;
            let mut tracker = self.tracker.lock().unwrap_or_else(|e| e.into_inner());
            match event {
                ServiceEvent::ServiceResolved(info) => {
                    if let Ok(a) = announce_from_service(&info) {
                        tracker.found(info.get_fullname(), a.device_id);
                        return Some(DiscoveryEvent::Found(a));
                    }
                }
                ServiceEvent::ServiceRemoved(_, fullname) => {
                    if let Some(id) = tracker.removed(&fullname) {
                        return Some(DiscoveryEvent::Lost(id));
                    }
                }
                _ => {}
            }
        }
    }

    pub fn stop(&self) {
        let _ = self.daemon.shutdown();
    }
}

pub fn announce_from_service(info: &ServiceInfo) -> Result<PeerAnnounce> {
    let props = info.get_properties();
    announce_from_props(
        |k| props.get_property_val_str(k).map(str::to_string),
        info.get_hostname(),
        info.get_addresses().iter().copied(),
        info.get_port(),
    )
}

/// Build a `PeerAnnounce` from TXT values that any discovery backend supplies.
/// `get` returns the value of one TXT key.
pub(crate) fn announce_from_props(
    get: impl Fn(&str) -> Option<String>,
    hostname: &str,
    addrs: impl Iterator<Item = IpAddr>,
    port: u16,
) -> Result<PeerAnnounce> {
    let id_hex =
        get("id").ok_or_else(|| CoreError::Discovery("service missing 'id' txt".into()))?;
    let bytes = hex::decode(id_hex).map_err(|e| CoreError::Discovery(e.to_string()))?;
    let device_id: [u8; 16] = bytes
        .try_into()
        .map_err(|_| CoreError::Discovery("device id must be 16 bytes".into()))?;
    let name = get("name").unwrap_or_else(|| hostname.to_string());
    let proto_version = get("v")
        .and_then(|v| v.parse().ok())
        .unwrap_or(PROTO_VERSION);
    let capabilities = get("caps").and_then(|v| v.parse().ok()).unwrap_or(0);
    let status = get("st").unwrap_or_else(|| "unknown".to_string());
    let addr = pick_addr(addrs, port)
        .ok_or_else(|| CoreError::Discovery("service has no address yet".into()))?;
    Ok(PeerAnnounce {
        device_id,
        name,
        addr,
        port,
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
            _ => 3,
        }
    }
    addrs
        // EXCLUDE loopback and unspecified rather than rank them low. The
        // record's address list is not a dial list: an AUTO advertiser
        // (ServiceDaemon fills it) publishes every address the HOST owns, so
        // the list can contain `127.0.0.1`, `::1` and `fe80::1%lo0` -- the
        // loopback of a machine that is not the caller's. Ranked, those still
        // WIN when the LAN address is IPv6, and then the send fails: measured,
        // the engine resolved a live peer at `[fe80::1]:45930` and the dial
        // returned `No route to host` while the same peer answered on
        // `192.168.0.226:45930`.
        //
        // There is no reachable peer behind either address, so dropping them
        // costs nothing and removes the whole class. `is_loopback()` covers
        // `127.0.0.0/8` and `::1`; `is_unspecified()` covers `0.0.0.0` and `::`,
        // which `advertise_ip` already keeps out of OUR OWN record but which a
        // peer's record can still carry.
        //
        // LINK-LOCAL IPv6 (`fe80::/10`) goes here too, and for a different reason
        // than loopback: it needs an interface SCOPE ID on every connect, and a
        // `SocketAddr` cannot carry one. The mDNS record publishes the bare
        // address, so a browsing peer necessarily dials a scope-less
        // `fe80::...` and gets `No route to host` (errno 65) -- measured, while
        // the same address WITH a scope connected, and so did the peer's IPv4
        // address at the same moment. No rank repairs this, because the address
        // is unusable in the form the wire carries it.
        //
        // LINK-LOCAL IPv4 (`169.254.0.0/16`) is KEPT. It needs no scope, so it
        // is dialable exactly as published, and it is the address a phone gets
        // on a network with no DHCP lease. Dropping it would break that case.
        //
        // An IPv6 UNIQUE-LOCAL address (`fc00::/7`) is kept for the same reason.
        // A v6-only peer keeps working wherever it is routed.
        .filter(|ip| !ip.is_loopback() && !ip.is_unspecified())
        .filter(|ip| match ip {
            IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) != 0xfe80,
            IpAddr::V4(_) => true,
        })
        .min_by_key(|ip| (rank(*ip), *ip))
        .map(|ip| SocketAddr::new(ip, port))
}

/// This host's LAN address, for a caller that must hand a PEER something to
/// dial and that cannot wait for a browse.
///
/// Every shipped engine binds a WILDCARD, so `Engine::local_addr()` is
/// `[::]:port` and names no host. The mDNS record solves this for a browsing
/// peer because `addr_auto` fills it with the host's interface addresses, but a
/// pairing bundle is read before any browse happens, and a network where
/// multicast does not cross (measured: a NAT-ed Android emulator saw zero
/// peers while unicast reached the host) never fills it at all.
///
/// So the answer is taken from the same interface list `addr_auto` uses and
/// ranked by the same [`pick_addr`], which is what keeps the two paths from
/// disagreeing about which address is the LAN one. It is deliberately NOT the
/// wildcard: `None` is the honest answer for a host with no routable address,
/// and the joiner then falls back to discovery.
///
/// `port` is the caller's listener port. An interface list carries no port, so
/// there is no other honest source for it.
pub fn host_lan_addr(port: u16) -> Option<SocketAddr> {
    let ifs = if_addrs::get_if_addrs().unwrap_or_default();
    // A tunnel address is not dialable from the LAN, so it never competes.
    let lan: Vec<IpAddr> = ifs
        .iter()
        .filter(|i| is_lan_interface(&i.name))
        .map(|i| i.ip())
        .collect();
    // The unfiltered list is the fallback for a host whose only interfaces are
    // tunnels: a wrong address still beats no address for a caller that must
    // hand a peer something to dial.
    let addrs: Vec<IpAddr> = if lan.is_empty() {
        ifs.into_iter().map(|i| i.ip()).collect()
    } else {
        lan
    };
    pick_addr(addrs.into_iter(), port)
}

pub(crate) fn sanitize_host(name: &str) -> String {
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

pub(crate) fn txt_short(value: &str, max_chars: usize) -> Option<String> {
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
    fn announce_from_props_reads_every_txt_key() {
        let id = [9u8; 16];
        let get = |k: &str| match k {
            "id" => Some(hex::encode(id)),
            "name" => Some("Kitchen".to_string()),
            "v" => Some("1".to_string()),
            "caps" => Some("7".to_string()),
            "st" => Some("online".to_string()),
            _ => None,
        };
        let addrs = ["192.168.0.50".parse::<IpAddr>().unwrap()];
        let a = announce_from_props(get, "host.local.", addrs.into_iter(), 4000).unwrap();
        assert_eq!(a.device_id, id);
        assert_eq!(a.name, "Kitchen");
        assert_eq!(a.port, 4000);
        assert_eq!(a.capabilities, 7);
        assert_eq!(a.status, "online");
        assert_eq!(a.addr.to_string(), "192.168.0.50:4000");
    }

    #[test]
    fn announce_from_props_rejects_a_record_without_an_id() {
        let get = |_: &str| None;
        let addrs = ["192.168.0.50".parse::<IpAddr>().unwrap()];
        assert!(announce_from_props(get, "h.local.", addrs.into_iter(), 4000).is_err());
    }

    const LOCAL_ID_HEX: &str = "aabbccddeeff00112233445566778899";
    const PEER_ID_HEX: &str = "11111111111122222222333344445555";

    fn local_device_id() -> [u8; 16] {
        let mut id = [0u8; 16];
        hex::decode_to_slice(LOCAL_ID_HEX, &mut id).unwrap();
        id
    }

    /// Assert the real suffix form, the one naming.rs builds for a collision.
    /// An ends_with check also accepts the numeric fallback in naming.rs, so
    /// this pins the two wordlist words instead.
    fn assert_adjective_animal_suffix(got: &str, base: &str, context: &str) {
        let marker = format!(" · {base}");
        let prefix = got.strip_suffix(&marker).unwrap_or_else(|| {
            panic!("{context}: got {got}, which does not end with the marker {marker}")
        });
        let parts: Vec<&str> = prefix.split(' ').collect();
        assert_eq!(
            parts.len(),
            2,
            "{context}: {got} must be an adjective and an animal before the marker"
        );
        assert!(
            crate::wordlist::ADJECTIVES.contains(&parts[0]),
            "{context}: {} is not a wordlist adjective, in {got}",
            parts[0]
        );
        assert!(
            crate::wordlist::ANIMALS.contains(&parts[1]),
            "{context}: {} is not a wordlist animal, in {got}",
            parts[1]
        );
    }

    /// Build a resolved service record the way start_with_meta builds one.
    fn service_record(id_hex: &str, name: &str) -> mdns_sd::ServiceInfo {
        let mut props = HashMap::new();
        props.insert("id".to_string(), id_hex.to_string());
        props.insert("name".to_string(), name.to_string());
        props.insert("v".to_string(), PROTO_VERSION.to_string());
        let host = name.replace(' ', "-");
        mdns_sd::ServiceInfo::new(
            SERVICE_TYPE,
            &host,
            &format!("{}.local.", host),
            "192.168.1.44",
            40_001,
            props,
        )
        .unwrap()
    }

    // R45. A rename replaces our own mDNS registration, but the OLD record is
    // still on the LAN for the length of the browse window. The resolver read
    // that old record as a collision with itself, so the name the user typed
    // never appeared. The decision is pulled into a pure function so it is
    // testable without a socket.
    #[test]
    fn an_announcement_from_our_own_device_is_skipped_but_a_peer_is_kept() {
        let ours = Some(local_device_id());
        assert!(
            is_own_advertisement(Some(local_device_id()), ours),
            "our own advertisement must be skipped: it is the record we are replacing, not a peer"
        );
        assert!(
            !is_own_advertisement(Some([0x11u8; 16]), ours),
            "a different device id is a real peer and must be kept"
        );
        assert!(
            !is_own_advertisement(None, ours),
            "an announcement with no usable id is not provably ours, so it must be kept"
        );
        assert!(
            !is_own_advertisement(Some(local_device_id()), None),
            "a record with no device id cannot match our own id, so the filter keeps it"
        );
    }

    // R45. The end to end shape of the defect, without a socket: the initial
    // collision browse sees our own previous record plus a real peer, and the
    // resolved name is the name the user typed.
    #[test]
    fn a_rename_does_not_count_our_own_advertisement_as_a_collision() {
        use rand::SeedableRng;

        let typed = "ZZPROBE-NAME";
        let old_own_record = service_record(LOCAL_ID_HEX, typed);
        let mut rng = rand::rngs::StdRng::seed_from_u64(7);

        let collisions = observed_names_from_records(
            std::slice::from_ref(&old_own_record),
            Some(local_device_id()),
        );
        assert_eq!(
            collisions,
            Vec::<String>::new(),
            "our own previous record must not be a collision with ourselves"
        );
        assert_eq!(
            crate::discovery::naming::resolve_name(typed, &collisions, &mut rng),
            typed,
            "a rename must keep the exact name the user typed"
        );

        let peer_record = service_record("11111111111122222222333344445555", typed);
        let mixed =
            observed_names_from_records(&[old_own_record, peer_record], Some(local_device_id()));
        assert_eq!(
            mixed,
            vec![typed.to_string()],
            "a real peer claiming the same name must still be a collision"
        );
        let mut rng2 = rand::rngs::StdRng::seed_from_u64(7);
        let resolved = crate::discovery::naming::resolve_name(typed, &mixed, &mut rng2);
        assert_adjective_animal_suffix(&resolved, typed, "a real peer must get the suffix");
    }

    // R45c. The ONE collision-set function. The browse loop buffers its resolved
    // records and calls this. The tests call this. There is no second copy, so a
    // change to the filter must break a test.
    #[test]
    fn our_own_record_is_not_a_collision_but_a_peer_with_another_id_is() {
        let typed = "Shared Name";
        let ours = service_record(LOCAL_ID_HEX, typed);
        let peer = service_record(PEER_ID_HEX, typed);

        assert_eq!(
            observed_names_from_records(std::slice::from_ref(&ours), Some(local_device_id())),
            Vec::<String>::new(),
            "our own record is not a collision with ourselves"
        );
        assert_eq!(
            observed_names_from_records(std::slice::from_ref(&peer), Some(local_device_id())),
            vec![typed.to_string()],
            "a real peer keeps a DIFFERENT device id, so it must still collide"
        );
    }

    // R45c. The recheck must keep a real peer that already holds the chosen
    // name. That guard is the whole point of the recheck browse. This test
    // reaches the DECISION. The call site is pinned by the two tests below.
    #[test]
    fn the_recheck_filter_still_keeps_a_real_peer_holding_the_chosen_name() {
        let chosen = "Taken";
        let ours = service_record(LOCAL_ID_HEX, chosen);
        let peer = service_record(PEER_ID_HEX, chosen);
        let late = observed_names_from_records(&[ours, peer], Some(local_device_id()));
        assert_eq!(
            late,
            vec![chosen.to_string()],
            "the recheck must still report a real peer holding the chosen name"
        );
        assert!(
            late.iter().any(|n| n == chosen),
            "and the guard in the recheck loop reads exactly this list"
        );
    }

    // R45c. The two call sites. A reviewer's mutation proved that no test reached
    // them: one token at either line restores or removes the fix, and every test
    // stayed green. The tests above reach the DECISION, not the ARGUMENT. This
    // one reaches the argument by reading the source, because this host denies
    // socket(2) to the process that runs it.
    //
    // What this proves: both browse call sites pass Some(device_id).
    // What this does NOT prove: that a real socket browse finds the records the
    // shared function is handed. The two tests above cover that half, with
    // synthetic records. The two socket tests after it cover it for real.
    #[test]
    fn both_browse_call_sites_pass_our_own_device_id() {
        let src = include_str!("mdns.rs");
        for (label, window) in [
            ("initial browse", "BROWSE_WINDOW"),
            ("recheck browse", "RECHECK_WINDOW"),
        ] {
            let wanted = format!("browse_observed_names({window}, Some(device_id))");
            assert!(
                src.contains(&wanted),
                "the {label} must pass Some(device_id), or our own record is a \
                 collision with itself. Expected this source: {wanted}"
            );
            let forbidden = format!("browse_observed_names({window}, None)");
            assert!(
                !src.contains(&forbidden),
                "the {label} must not pass None. With None the recheck sees our own \
                 fresh record, so its guard is always false and every free name \
                 comes back suffixed. Rejected this source: {forbidden}"
            );
        }
    }

    // R45c. The INITIAL call site. This test keeps an OLD registration of our
    // OWN device alive across the browse, because that is the real rename: the
    // previous record is still on the wire for the length of the window. With
    // Some(device_id) the old record is a self-match and is filtered, so the
    // typed name survives. With None the old record is a collision with
    // ourselves and the name comes back as Adjective Animal.
    //
    // This test drives the REAL resolve path over a REAL socket. It is one of
    // only two tests that reach the browse call sites through production code.
    // THE CONTROLLER MUST RUN IT outside a sandbox, because this host denies
    // socket(2) to a sandboxed process.
    #[test]
    fn the_initial_browse_resolves_a_free_name_to_the_typed_name() {
        let typed = format!("R45C-INITIAL-{}", local_device_id()[0]);
        let old = Advertiser::start(&typed, 41_001, local_device_id()).expect(
            "the old registration must start, so the initial browse has a \
             self-match to filter",
        );
        let adv =
            Advertiser::start_resolving(&typed, 41_001, local_device_id(), &mut rand::thread_rng())
                .expect("a browse that cannot start must not fail the resolve");
        assert_eq!(
            adv.1, typed,
            "the initial browse must not read our own previous record as a \
             collision, so a free name stays exactly as typed"
        );
        adv.0.stop();
        old.stop();
    }

    // R45c. The RECHECK call site. No old registration here, so the only record
    // on the LAN with this name is the one start_resolving has just made. With
    // Some(device_id) the recheck filters that fresh self-match, the guard sees
    // no peer, and the first candidate is returned. With None the fresh record is
    // in the list, the guard is always false, and the name comes back as
    // Adjective Animal. This is the defect the reviewer measured.
    #[test]
    fn the_recheck_browse_does_not_suffix_a_free_name() {
        let typed = format!("R45C-RECHECK-{}", local_device_id()[0]);
        let adv =
            Advertiser::start_resolving(&typed, 41_002, local_device_id(), &mut rand::thread_rng())
                .expect("a browse that cannot start must not fail the resolve");
        assert_eq!(
            adv.1, typed,
            "the recheck must filter our own fresh record, or its guard is \
             always false and a free name comes back as Adjective Animal"
        );
        adv.0.stop();
    }

    // R45e. `assert_adjective_animal_suffix` is the only assertion that pins the
    // suffix FORM. naming.rs has two suffix forms: the wordlist form
    // `{adj} {animal} · {base}` and the numeric fallback `{base} {n}` after 64
    // tries. The helper must reject the fallback, or it would accept a numeric
    // suffix as a pass and the wordlist pin would be worthless. No test measured
    // the rejection, so it rested on a comment. This one measures it.
    #[test]
    fn the_suffix_assertion_rejects_the_numeric_fallback_form() {
        let base = "Fallback Base";

        let wordlist_form = format!("Seawood Otter · {base}");
        assert_adjective_animal_suffix(&wordlist_form, base, "the wordlist form must pass");

        // The fallback form is `{base} {n}`, with a SPACE and no marker.
        let numeric_form = format!("{base} 2");
        let verdict = std::panic::catch_unwind(|| {
            assert_adjective_animal_suffix(
                &numeric_form,
                base,
                "the numeric form must be rejected",
            );
        });
        assert!(
            verdict.is_err(),
            "the helper accepted the numeric fallback form {numeric_form}, so a numeric \
             suffix would pass the wordlist pin"
        );
    }

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

    /// The record's ADDRESS LIST is not a dial list. `ServiceDaemon` in AUTO
    /// mode publishes every address the host owns, and on the measured machine
    /// that set included `127.0.0.1`, `::1` AND `fe80::1%lo0` -- the loopback
    /// of a machine that is not the caller's. Measured with a real browse: the
    /// engine resolved a live peer at `[fe80::1]:45930` in every run, and the
    /// dial died with `No route to host` while the same peer answered on
    /// `192.168.0.226:45930`.
    ///
    /// Ranking is not enough here, because a rank has no way to express "this
    /// address only works when the peer IS this machine". A browsing peer must
    /// never be handed a loopback address at all: it is either undialable
    /// (`No route to host` on the v6 form) or -- worse, on the v4 form -- it
    /// silently reaches the CALLER's own loopback, so the send either hangs or
    /// errors on a peer that is not there at all.
    ///
    /// So `pick_addr` now EXCLUDES loopback and unspecified addresses. There is
    /// no reachable peer behind either. The private/link-local IPv4 and the
    /// link-local IPv6 stay, because those are the LAN addresses the whole
    /// product is built on.
    #[test]
    fn pick_addr_never_returns_a_loopback_or_unspecified_address() {
        // Exactly the set `ServiceDaemon` published for a wildcard advertiser
        // on this host, including the loopback that cost every send.
        let _published: Vec<IpAddr> = vec![
            "127.0.0.1".parse().unwrap(),
            "::1".parse().unwrap(),
            "fe80::1".parse().unwrap(),
            "192.168.0.226".parse().unwrap(),
        ];

        // Whichever order they arrive in, and however many loopbacks lead, the
        // answer must be the LAN address.
        for order in [
            vec!["127.0.0.1", "::1", "fe80::1", "192.168.0.226"],
            vec!["fe80::1", "::1", "127.0.0.1", "192.168.0.226"],
        ] {
            let addrs: Vec<IpAddr> = order.iter().map(|s| s.parse().unwrap()).collect();
            let chosen =
                pick_addr(addrs.into_iter(), 40001).expect("a reachable LAN address is in the set");
            assert_eq!(
                chosen.ip(),
                "192.168.0.226".parse::<IpAddr>().unwrap(),
                "loopback must never win: order was {order:?}"
            );
        }

        // Link-local IPv6 alone must yield None. It is a real LAN address, but
        // NOT one this function can return usefully: it needs an interface
        // scope id that a `SocketAddr` cannot carry, so the caller would dial
        // `fe80::1` with no scope and get `No route to host`. Superseded by
        // `pick_addr_never_returns_a_link_local_ipv6_address`, which measures
        // the errno. Reporting None is the honest answer and discovery retries.
        let v6_only: Vec<IpAddr> = vec!["::1".parse().unwrap(), "fe80::1".parse().unwrap()];
        assert!(
            pick_addr(v6_only.into_iter(), 40001).is_none(),
            "a scope-less link-local IPv6 must not be handed back as a dial target"
        );

        // Nothing dialable in the set: say so instead of handing back a
        // loopback that silently targets the wrong machine.
        let all_loopback: Vec<IpAddr> = vec!["127.0.0.1".parse().unwrap(), "::1".parse().unwrap()];
        assert!(
            pick_addr(all_loopback.into_iter(), 40001).is_none(),
            "an address set with no reachable peer must resolve to None"
        );

        // The unspecified address is never dialable, so it must be filtered by
        // the same guard rather than by a lower rank.
        let unspecified: Vec<IpAddr> = vec!["0.0.0.0".parse().unwrap(), "::".parse().unwrap()];
        assert!(
            pick_addr(unspecified.into_iter(), 40001).is_none(),
            "an unspecified address must never be returned"
        );
    }

    /// A LINK-LOCAL IPv6 address is not self-routing. `fe80::/10` needs an
    /// interface SCOPE ID on every connect, and `SocketAddr` has nowhere to
    /// carry one: the mDNS A/AAAA record publishes the bare address, so a
    /// browsing peer necessarily builds a scope-less `SocketAddr`. Measured on
    /// the dual-stack listener: `fe80::1` with no scope returned `No route to
    /// host` (errno 65), while the same address with scope 1 connected, and so
    /// did `fe80::...%en0` with scope 11. Every send over a link-local answer
    /// therefore fails at dial, which is what "does not transfer" was.
    ///
    /// No rank can repair this, because the address is genuinely unusable in the
    /// form the wire carries it. So link-local IPv6 is EXCLUDED from the answer
    /// and private IPv4 is preferred absolutely. IPv4 is what every platform
    /// Daak ships on carries, and a v6-only peer still works: its record then
    /// offers no usable address at all, `pick_addr` returns `None`, and
    /// discovery reports "service has no address yet" -- an honest, retryable
    /// state instead of a send that can never succeed.
    #[test]
    fn pick_addr_never_returns_a_link_local_ipv6_address() {
        // The exact set the daemon published for a dual-stack wildcard bind on
        // this host. `fe80::...%en0` IS the working LAN address, so dropping it
        // costs nothing only because `192.168.0.226` is also in the set.
        let published: Vec<IpAddr> = vec![
            "192.168.0.226".parse().unwrap(),
            "fe80::1470:58d2:1c29:d79f".parse().unwrap(),
        ];
        assert_eq!(
            pick_addr(published.into_iter(), 40001).unwrap().ip(),
            "192.168.0.226".parse::<IpAddr>().unwrap(),
            "a scope-less link-local IPv6 can never be dialled, so the IPv4 LAN address must win"
        );

        // Link-local IPv6 ALONE must yield None, never a dial target. This is
        // the case that must not silently become a send that never lands.
        let v6_only: Vec<IpAddr> = vec![
            "fe80::1".parse().unwrap(),
            "fe80::1470:58d2:1c29:d79f".parse().unwrap(),
        ];
        assert!(
            pick_addr(v6_only.into_iter(), 40001).is_none(),
            "a record with no IPv4 LAN address must report no address, not an unusable one"
        );

        // An IPv6 UNIQUE-LOCAL address (`fc00::/7`) needs no scope and is kept,
        // so a v6-only LAN still works where it is routed.
        let ula: Vec<IpAddr> = vec!["fd00::1".parse().unwrap()];
        assert_eq!(
            pick_addr(ula.into_iter(), 40001).unwrap().ip(),
            "fd00::1".parse::<IpAddr>().unwrap(),
            "unique-local IPv6 is routable without a scope and must stay selectable"
        );
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

    // W-FW-2 regression, root cause. An engine that binds an explicit
    // interface must advertise THAT interface. Under enable_addr_auto() the
    // record carried every host address, so a peer on 127.0.0.1 published
    // <lan-ip>:<port> as well; the next announce then overwrote the good
    // loopback address in the device map with one nothing listens on, and a
    // delivered transfer was re-pointed at a dead address mid-test.
    #[test]
    fn an_explicit_bind_ip_is_published_verbatim_without_addr_auto() {
        let info = Advertiser::service_info(
            "bind ip test",
            40_999,
            HashMap::new(),
            Some("127.0.0.1".parse().unwrap()),
        )
        .unwrap();
        assert_eq!(
            info.get_addresses().iter().copied().collect::<Vec<_>>(),
            vec!["127.0.0.1".parse::<IpAddr>().unwrap()],
            "the record must carry exactly the bound address, not the host's"
        );
        assert!(
            !info.is_addr_auto(),
            "addr_auto would re-add every host interface on the next network \
             change and silently move the record off the bound address"
        );
    }

    #[test]
    fn the_auto_form_still_advertises_host_interfaces() {
        let info =
            Advertiser::service_info("auto addr test", 40_998, HashMap::new(), None).unwrap();
        assert!(
            info.is_addr_auto(),
            "None is the WILDCARD-BIND form, and every shipped entry point \
             binds 0.0.0.0, so this is the production path: the record is left \
             to the daemon, which fills it with the host's real interfaces"
        );
        assert!(
            info.get_addresses().is_empty(),
            "the auto form starts empty and is filled by the daemon"
        );
    }

    // B-1. `tcp::bind` reports the REQUESTED address back, so a wildcard bind
    // reports `0.0.0.0`. The engine's advertise_ip maps that back to None, and
    // these two facts have to hold together: the mapping, and the fact that a
    // record built from a wildcard bind therefore carries no unspecified
    // address and keeps addr_auto (so the daemon, not a literal `0.0.0.0`,
    // decides what is published). The reviewer's defect: the `Some` arm took
    // `Some(0.0.0.0)` and published it verbatim, and a peer's pick_addr does
    // NOT filter the unspecified address -- it handed back `0.0.0.0:<port>`,
    // which `tcp::dial` refuses as non-local. Total loss of the send path on
    // every real deployment.
    #[test]
    fn a_wildcard_bind_keeps_addr_auto_and_never_publishes_the_wildcard() {
        assert_eq!(
            advertise_ip(IpAddr::from([0, 0, 0, 0])),
            None,
            "0.0.0.0 means 'every interface', not 'this address', so it must \
             take the auto form"
        );
        assert_eq!(
            advertise_ip("::".parse().unwrap()),
            None,
            ":: is the same statement in v6 form and must map the same way"
        );
        assert_eq!(
            advertise_ip("127.0.0.1".parse().unwrap()),
            Some("127.0.0.1".parse().unwrap()),
            "an EXPLICIT interface is the one case Some means, and it is kept"
        );

        let info = Advertiser::service_info(
            "wildcard bind test",
            40_997,
            HashMap::new(),
            advertise_ip(IpAddr::from([0, 0, 0, 0])),
        )
        .unwrap();
        assert!(
            !info.get_addresses().iter().any(|ip| ip.is_unspecified()),
            "a wildcard bind must not publish the wildcard: a peer reads it as \
             an address to dial, and dial refuses it as non-local. addresses = {:?}",
            info.get_addresses()
        );
        assert!(
            info.is_addr_auto(),
            "and the daemon must stay free to fill in the host's real \
             interfaces, which is what makes the record dialable"
        );
    }

    // Measured on the developer's Mac: with a VPN connected the host owned
    // 10.7.0.1 on a tunnel AND 192.168.0.226 on the LAN. A tunnel address is
    // not dialable from the LAN, and pick_addr prefers the numerically smaller
    // private IPv4, so the tunnel won and every peer dialled it.
    #[test]
    fn pick_addr_alone_prefers_a_vpn_tunnel_address() {
        let picked = pick_addr(
            ["10.7.0.1", "192.168.0.226"]
                .iter()
                .map(|a| a.parse().unwrap()),
            4_000,
        )
        .unwrap();
        assert_eq!(
            picked.ip().to_string(),
            "10.7.0.1",
            "this is the defect is_lan_interface exists to remove"
        );
    }

    #[test]
    fn a_tunnel_interface_is_not_a_lan_interface() {
        for name in ["en0", "en1", "eth0", "wlan0", "bridge100"] {
            assert!(is_lan_interface(name), "{name} is a LAN interface");
        }
        for name in [
            "utun0", "utun3", "ipsec0", "ppp0", "tun0", "tap0", "awdl0", "llw0", "lo0",
        ] {
            assert!(!is_lan_interface(name), "{name} must not count as the LAN");
        }
    }

    #[test]
    fn the_lan_address_wins_once_tunnels_are_filtered() {
        let all = [
            ("utun3", "10.7.0.1"),
            ("en0", "192.168.0.226"),
            ("awdl0", "169.254.1.1"),
        ];
        let lan: Vec<IpAddr> = all
            .iter()
            .filter(|(n, _)| is_lan_interface(n))
            .map(|(_, ip)| ip.parse().unwrap())
            .collect();
        assert_eq!(
            pick_addr(lan.into_iter(), 4_000).unwrap().ip().to_string(),
            "192.168.0.226"
        );
    }

    #[tokio::test]
    async fn test_daemons_do_not_use_a_lan_interface() {
        let id: [u8; 16] = rand::random();
        let name = format!("loopback-only-{}", hex::encode(&id[..4]));
        let adv = Advertiser::start(&name, 40_123, id).unwrap();
        let browser = Browser::start().unwrap();
        // A browser finds this advertiser only through a real interface.
        // The test passes when no Found event with this device id arrives.
        let seen = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while let Some(event) = browser.recv().await {
                if matches!(&event, DiscoveryEvent::Found(a) if a.device_id == id) {
                    return true;
                }
            }
            false
        })
        .await;
        adv.stop();
        browser.stop();
        assert!(
            !matches!(seen, Ok(true)),
            "the browser found the advertiser"
        );
    }
}
