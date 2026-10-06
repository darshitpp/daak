use daak_core::net::tcp;
use std::net::SocketAddr;
use std::time::Duration;

/// WHY THIS EXISTS. Every shipped entry point asks `tcp::bind` for a WILDCARD
/// address: `0.0.0.0:{port}` in daakd, daak-ffi and daak-cli. Every one of
/// them then runs the mDNS advertiser, whose AUTO form (`Advertiser::service_info`
/// -> `enable_addr_auto`, reached whenever `advertise_ip` maps the wildcard back
/// to `None`) publishes EVERY interface address the host has -- on this machine
/// `192.168.0.226` AND `fe80::1%lo0` AND `::1`.
///
/// A browsing peer's `pick_addr` is free to choose any of them, and it ranked
/// `fe80::1` above nothing simply because it is a link-local IPv6. The result
/// measured on this host: three of four discovery runs returned
/// `[fe80::1]:45940`, and dialing it fails with `No route to host`, while the
/// very same peer is reachable at `192.168.0.226:45940`. The IPv4 wildcard
/// listener never had a socket on the IPv6 side, so the send hard-fails at
/// "peer is not paired" (engine.rs:476) after burning the whole retry budget.
/// The transport is fine: `crates/daak-core/tests/outbox.rs` delivers over an
/// explicit loopback address every time.
///
/// THE FIX IS HERE, AT THE BIND, NOT IN `pick_addr`. Filtering the ADDRESS the
/// browser chose would only move the loss to the peer that published it, and a
/// peer legitimately has addresses we cannot rank. A wildcard bind means
/// "every interface", so it must ACTUALLY listen on every interface. Binding
/// the IPv6 wildcard `[::]` with `IPV6_V6ONLY` off accepts IPv4 connections on
/// the same socket (measured: all five probe addresses connect), so one bind
/// now covers every address the advertiser is free to publish.
///
/// Binds sockets, so it needs an unsandboxed run.
#[tokio::test]
async fn a_wildcard_listen_reaches_every_address_the_advertiser_can_publish() {
    // The exact shape every entry point requests, so this test fails if the
    // normalisation is ever dropped from `bind`.
    let (_listener, local) = tcp::bind("0.0.0.0:0".parse::<SocketAddr>().unwrap())
        .await
        .unwrap();

    let mut failures = Vec::new();

    // IPv6 loopback: the family discovery handed back in three of four runs.
    let v6: SocketAddr = format!("[::1]:{}", local.port()).parse().unwrap();
    if let Err(e) = tcp::dial(v6).await {
        failures.push(format!("dial {v6} (advertised IPv6) failed: {e}"));
    }

    // IPv4 loopback: the family that worked before, kept as the regression
    // guard. A fix that made the bind IPv6-ONLY would break this line.
    let v4: SocketAddr = format!("127.0.0.1:{}", local.port()).parse().unwrap();
    if let Err(e) = tcp::dial(v4).await {
        failures.push(format!("dial {v4} (IPv4) failed: {e}"));
    }

    assert!(
        failures.is_empty(),
        "a wildcard bind must listen on BOTH families, because the advertiser publishes both:\n{}",
        failures.join("\n")
    );
}

/// `dial` alone proves reachability, not that the listener ACCEPTS. One accept
/// round-trip closes the loop, so a listener that accepts nothing is caught even
/// when every dial succeeded. Same root cause, same bind, separate assertion so a
/// regression names which half broke.
#[tokio::test]
async fn a_wildcard_listener_accepts_an_ipv6_peer() {
    let (listener, local) = tcp::bind("0.0.0.0:0".parse::<SocketAddr>().unwrap())
        .await
        .unwrap();

    let accept_task = tokio::spawn(async move { tcp::accept(&listener).await.map(|_| ()) });

    // Over an explicit IPv6 address on a listener bound to the IPv4 wildcard:
    // this is the dial that returned "No route to host" in the field.
    tokio::time::timeout(
        Duration::from_secs(5),
        tcp::dial(
            format!("[::1]:{}", local.port())
                .parse::<SocketAddr>()
                .unwrap(),
        ),
    )
    .await
    .expect("IPv6 dial to an IPv4-wildcard listener timed out")
    .expect("IPv6 dial to an IPv4-wildcard listener was refused");

    tokio::time::timeout(Duration::from_secs(5), accept_task)
        .await
        .expect("the listener never accepted the IPv6 connection")
        .expect("the accept task panicked")
        .expect("the listener rejected a local IPv6 peer");
}
