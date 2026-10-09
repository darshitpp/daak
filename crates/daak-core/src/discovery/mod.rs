#[cfg(any(target_os = "ios", all(test, target_os = "macos")))]
pub mod dnssd;
pub mod mdns;
pub mod naming;
pub mod presence;
pub mod records;

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
pub use records::{DiscoveryEvent, RecordTracker};

/// Start the advertiser and resolve the display name without blocking a tokio worker.
///
/// The name check waits on a socket with std timeouts (about 650 ms).
/// `spawn_blocking` runs that wait on a blocking thread.
/// The caller still waits for the result, because the engine needs the name.
/// The wait frees the worker. It does not become shorter.
pub(crate) async fn start_resolving_off_runtime(
    base_name: String,
    port: u16,
    device_id: [u8; 16],
    bind_ip: Option<std::net::IpAddr>,
) -> crate::error::Result<(Advertiser, String)> {
    use rand::SeedableRng;
    // `thread_rng` is not `Send`, so the closure seeds a `StdRng` on its own thread.
    tokio::task::spawn_blocking(move || {
        let mut rng = rand::rngs::StdRng::from_entropy();
        Advertiser::start_resolving_on(&base_name, port, device_id, &mut rng, bind_ip)
    })
    .await
    .map_err(|e| crate::error::CoreError::Discovery(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    // A current-thread runtime has one worker. A blocking name check stops the
    // ticker. The helper must let the ticker run.
    #[tokio::test(flavor = "current_thread")]
    async fn the_name_check_leaves_the_runtime_free() {
        let ticks = Arc::new(AtomicU32::new(0));
        let t = ticks.clone();
        let ticker = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(50)).await;
                t.fetch_add(1, Ordering::SeqCst);
            }
        });
        let (adv, _name) = start_resolving_off_runtime(
            format!("offrt-{}", hex::encode(rand::random::<[u8; 4]>())),
            40_321,
            rand::random(),
            None,
        )
        .await
        .unwrap();
        adv.stop();
        ticker.abort();
        assert!(ticks.load(Ordering::SeqCst) >= 3);
    }
}
