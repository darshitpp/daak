// The debug bundle that the "Report an issue" action shares.
//
// The bundle must build before `start`, because the user can report an
// issue after `start` fails. After `start`, it holds the device id and a
// dialable LAN address. It never holds the display name.
//
// Two tests bind sockets, so they need an unsandboxed run.

use daak_ffi::{EventSink, FfiEngine, FfiEvent};

struct Silent;
impl EventSink for Silent {
    fn on_event(&self, _event: FfiEvent) {}
}

/// The version line that `render` writes for the product `daak-ffi`. It is
/// the engine library version. The Settings screen adds the app version.
fn version_line() -> String {
    format!("daak-ffi {}\n", env!("CARGO_PKG_VERSION"))
}

/// Start an engine on a wildcard port with the display name `name`.
fn started(name: &str) -> (FfiEngine, tempfile::TempDir) {
    // start() binds a wildcard port, so keep the announce off the LAN.
    std::env::set_var("DAAK_MDNS_OFF_LAN", "1");
    let dir = tempfile::tempdir().unwrap();
    let engine = FfiEngine::new(Box::new(Silent));
    engine
        .start(dir.path().to_string_lossy().into(), name.into(), 0)
        .unwrap();
    (engine, dir)
}

#[test]
fn bundle_works_before_start() {
    let engine = FfiEngine::new(Box::new(Silent));
    let bundle = engine.export_debug_bundle().unwrap();
    assert!(bundle.contains(&version_line()), "got {bundle}");
    assert!(
        bundle.contains("device_id: engine: not started\n"),
        "got {bundle}"
    );
    assert!(
        bundle.contains("listen_addr: engine: not started\n"),
        "got {bundle}"
    );
}

#[test]
fn bundle_after_start_holds_device_id_and_a_dialable_address_not_a_wildcard() {
    let (engine, _dir) = started("host");
    let profile: serde_json::Value = serde_json::from_str(&engine.self_profile().unwrap()).unwrap();
    let device_id = profile["deviceId"].as_str().unwrap().to_string();
    let port = engine.local_port().unwrap();

    let bundle = engine.export_debug_bundle().unwrap();
    engine.shutdown().unwrap();

    assert!(bundle.contains(&version_line()), "got {bundle}");
    assert!(
        bundle.contains(&format!("device_id: {device_id}\n")),
        "got {bundle}"
    );
    assert!(!bundle.contains("engine: not started"), "got {bundle}");
    // The same helper that the pairing bundle uses gives the expected value.
    match daak_core::discovery::host_lan_addr(port) {
        Some(addr) => assert!(
            bundle.contains(&format!("listen_addr: {addr}\n")),
            "got {bundle}"
        ),
        None => assert!(bundle.contains("listen_addr: none\n"), "got {bundle}"),
    }
    let addr_line = bundle
        .lines()
        .find(|l| l.starts_with("listen_addr: "))
        .unwrap();
    assert!(!addr_line.contains("0.0.0.0"), "got {addr_line}");
    assert!(!addr_line.contains("[::]"), "got {addr_line}");
}

#[test]
fn bundle_holds_no_display_name() {
    let name = "Quokka-Display-Name-7319";
    let (engine, _dir) = started(name);
    let bundle = engine.export_debug_bundle().unwrap();
    engine.shutdown().unwrap();

    assert!(bundle.contains("=== identity ===\n"), "got {bundle}");
    assert!(!bundle.contains(name), "the bundle holds the display name");
    assert!(
        !bundle.contains("Quokka"),
        "the bundle holds the display name"
    );
}

#[test]
fn bundle_after_a_failed_start_holds_the_reason() {
    std::env::set_var("DAAK_MDNS_OFF_LAN", "1");
    // The engine binds the IPv6 wildcard. This listener holds that port
    // without SO_REUSEADDR, so the engine bind fails.
    let held = std::net::TcpListener::bind("[::]:0").unwrap();
    let port = held.local_addr().unwrap().port();
    let dir = tempfile::tempdir().unwrap();
    let engine = FfiEngine::new(Box::new(Silent));
    let started = engine.start(dir.path().to_string_lossy().into(), "host".into(), port);
    assert!(started.is_err(), "start must fail on a held port");

    let bundle = engine.export_debug_bundle().unwrap();
    assert!(
        bundle.contains("device_id: engine: not started\n"),
        "got {bundle}"
    );
    assert!(
        bundle.contains("start failed: io: AddrInUse"),
        "got {bundle}"
    );
    drop(held);
}
