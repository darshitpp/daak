#[cfg(any(target_os = "ios", all(test, target_os = "macos")))]
pub mod dnssd;
pub mod mdns;
pub mod naming;
pub mod presence;

pub mod beacon;
pub mod status;
pub use beacon::{pairing_presence_key, SealedBeacon};
pub use status::{
    Liveness, PresenceConfig, PresenceTracker, StatusChange, BEACON_INTERVAL_MS, FLAP_DEBOUNCE_MS,
    OFFLINE_MISSES,
};

// pub(crate): the engine normalises a wildcard bind before advertising. Not a
// public API -- a caller outside this crate has no listener to normalise.
pub(crate) use mdns::advertise_bind_ip;
pub use mdns::{host_lan_addr, PeerAnnounce, SERVICE_TYPE};
// iOS needs a restricted entitlement for raw multicast. The system responder
// needs none for a declared service type. See the iOS discovery design spec.
#[cfg(target_os = "ios")]
pub use dnssd::{Advertiser, Browser};
#[cfg(not(target_os = "ios"))]
pub use mdns::{Advertiser, Browser};
pub use naming::{default_display_name, resolve_name, unique_display_name};
pub use presence::{Presence, PresenceSocket, PresenceState, PRESENCE_GROUP, PRESENCE_PORT};
