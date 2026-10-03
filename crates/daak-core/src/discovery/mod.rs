pub mod mdns;
pub mod naming;
pub mod presence;

// pub(crate): the engine normalises a wildcard bind before advertising. Not a
// public API -- a caller outside this crate has no listener to normalise.
pub(crate) use mdns::advertise_ip;
pub use mdns::{Advertiser, Browser, PeerAnnounce, SERVICE_TYPE};
pub use naming::{default_display_name, resolve_name, unique_display_name};
pub use presence::{Presence, PresenceSocket, PresenceState, PRESENCE_GROUP, PRESENCE_PORT};
