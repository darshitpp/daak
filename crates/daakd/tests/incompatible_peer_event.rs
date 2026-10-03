// The compatibility signal, end to end on the DESKTOP bridge.
//
// crates/daak-ffi/tests/incompatible_peer_event.rs pins the mobile arm
// (EngineEvent -> FfiEvent -> JSON). crates/daak-ipc/tests/schema.rs pins that
// IpcEvent round-trips through the CDDL. Neither of those ever calls
// daakd::to_ipc_event, so without this file the whole desktop hop -- the one
// the daemon client in packages/core/src/engine/DaemonClient.ts actually reads
// -- could be deleted or pointed at the wrong variant and every test would
// still pass. It also pins the thing the two bridges must AGREE on: the exact
// same four field names and both real version numbers, because a desktop and a
// phone on the same LAN must not disagree about whether an update is needed.
use daak_core::engine::EngineEvent;
use daak_ipc::IpcEvent;
use daakd::to_ipc_event;

#[test]
fn the_engine_event_maps_onto_the_ipc_union_with_a_hex_id() {
    let IpcEvent::IncompatiblePeer {
        peer_device_id,
        peer_name,
        peer_version,
        our_version,
    } = to_ipc_event(EngineEvent::IncompatiblePeer {
        peer_device_id: [0xaau8; 16],
        peer_name: "Studio iMac".into(),
        peer_version: 200,
        our_version: 100,
    })
    else {
        panic!("IncompatiblePeer must reach the IPC union as itself");
    };
    // Same id encoding the FFI arm uses: hex, not a byte array in JSON.
    assert_eq!(peer_device_id, "aa".repeat(16));
    assert_eq!(peer_name, "Studio iMac");
    // THE point of the event: no version is defaulted, rounded or invented.
    assert_eq!(peer_version, 200);
    assert_eq!(our_version, 100);
}

/// ensure_compatible refuses on the MAJOR (version / 100), so a peer one major
/// ahead and a peer far ahead are both refused -- and the versions that reach
/// the UI must be the raw advertised values, not the major, so the screen can
/// say "they are on 2" rather than a bare "incompatible".
#[test]
fn a_refused_peer_version_is_carried_raw_not_reduced_to_its_major() {
    use daak_core::error::ensure_compatible;
    // The real gate, so this test fails if the gate ever changes under it.
    assert!(ensure_compatible(200).is_err());

    let IpcEvent::IncompatiblePeer {
        peer_version,
        our_version,
        ..
    } = to_ipc_event(EngineEvent::IncompatiblePeer {
        peer_device_id: [0u8; 16],
        peer_name: "old desktop".into(),
        peer_version: 200,
        our_version: 100,
    })
    else {
        panic!("IncompatiblePeer must reach the IPC union as itself");
    };
    assert_eq!(peer_version, 200);
    assert_eq!(our_version, 100);
}
