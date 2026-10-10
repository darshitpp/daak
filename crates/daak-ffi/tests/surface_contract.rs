// The cross-surface contract test.
//
// The iOS app, the Android app and the macOS app all drive the SAME Rust
// engine. What differs per surface is only the transport of the engine's
// events: the FFI build forwards them to JavaScript as the JSON that
// ffi_event_json builds, and the daemon turns them into IPC. So a headless
// pairing, transfer and unpair between two REAL engines, pushed through the
// real FFI mapping, is the app path with no device, no simulator and no
// emulator.
//
// This is the test that would have caught the empty peer id: it asserts the
// JSON the app actually receives, not a value the app never sees.
//
// Binds sockets, so it needs an unsandboxed run.

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::engine::{Engine, EngineConfig, EngineEvent};
use daak_core::manifest::{from_picked_paths, DeviceRef, CHUNK_SIZE_DEFAULT};
use daak_core::pairing::PairMode;
use daak_core::store::Db;
use daak_ffi::{ffi_event_json, to_ffi_event, to_pairing_sas_event};
use std::sync::Arc;
use std::time::Duration;

async fn engine(name: &str, out: std::path::PathBuf, db: Arc<Db>) -> Arc<Engine> {
    // This test starts real engines on loopback only, but the flag keeps a
    // wildcard announce out of the LAN if one ever changes.
    std::env::set_var("DAAK_MDNS_OFF_LAN", "1");
    let store = Arc::new(MemorySecretStore::default());
    let identity = import_from_store(store.as_ref()).unwrap();
    Arc::new(
        Engine::start(EngineConfig {
            display_name: name.into(),
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            out_dir: out,
            identity,
            db,
        })
        .await
        .unwrap(),
    )
}

fn db() -> Arc<Db> {
    let db = Arc::new(Db::open_in_memory().unwrap());
    db.migrate().unwrap();
    db
}

fn json_of(value: &str) -> serde_json::Value {
    serde_json::from_str(value).expect("ffi_event_json must return JSON")
}

/// Pair a host and a joiner for real, both gated on the SAS compare.
async fn paired() -> (
    Arc<Engine>,
    Arc<Db>,
    Arc<Engine>,
    Arc<Db>,
    [u8; 16],
    [u8; 16],
) {
    let (d1, d2) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (joiner_db, host_db) = (db(), db());
    let joiner = engine("joiner", d1.keep(), joiner_db.clone()).await;
    let host = engine("host", d2.keep(), host_db.clone()).await;
    joiner.set_pairing_confirmation_required(true);
    host.set_pairing_confirmation_required(true);
    let joiner_id = joiner.pairing_bundle().await.identity.device_id;
    let host_id = host.pairing_bundle().await.identity.device_id;
    host.offer_inbound_pairing(PairMode::Qr).await.unwrap();
    let accept = tokio::spawn({
        let host = host.clone();
        async move { host.accept_pairing_once_with_peer().await.unwrap() }
    });
    joiner
        .pair_with(host.local_addr(), host.pairing_bundle().await)
        .await
        .unwrap();
    let (_, peer) = accept.await.unwrap();
    assert_eq!(peer, joiner_id, "the host must learn the joiner id");
    joiner.confirm_pairing(host_id).await.unwrap();
    host.confirm_pairing(joiner_id).await.unwrap();
    (joiner, joiner_db, host, host_db, joiner_id, host_id)
}

/// Drain engine events through the REAL FFI mapping into the JSON that
/// JavaScript receives, until the stop test says the flow is complete.
async fn collect(
    events: &mut tokio::sync::broadcast::Receiver<EngineEvent>,
    stop: impl Fn(&[serde_json::Value]) -> bool,
) -> Vec<serde_json::Value> {
    let mut seen: Vec<serde_json::Value> = Vec::new();
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if stop(&seen) {
                return;
            }
            match tokio::time::timeout(Duration::from_millis(100), events.recv()).await {
                Ok(Ok(ev)) => {
                    let json = json_of(&ffi_event_json(&to_ffi_event(ev)).unwrap());
                    seen.push(json);
                }
                Ok(Err(_)) => return,
                Err(_) => {}
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("the flow never completed; saw {seen:?}"));
    seen
}

fn typed<'a>(seen: &'a [serde_json::Value], kind: &str) -> Vec<&'a serde_json::Value> {
    seen.iter().filter(|e| e["type"] == kind).collect()
}

#[tokio::test]
async fn an_inbound_pairing_sas_reaches_js_with_the_peer_id() {
    let (d1, d2) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let joiner = engine("joiner", d1.keep(), db()).await;
    let host = engine("host", d2.keep(), db()).await;
    let joiner_id = joiner.pairing_bundle().await.identity.device_id;
    host.offer_inbound_pairing(PairMode::Qr).await.unwrap();
    let accept = tokio::spawn({
        let host = host.clone();
        async move { host.accept_pairing_once_with_peer().await.unwrap() }
    });
    joiner
        .pair_with(host.local_addr(), host.pairing_bundle().await)
        .await
        .unwrap();
    let (sas, peer) = accept.await.unwrap();

    // Exactly what the FFI waiter sends to JavaScript.
    let json =
        json_of(&ffi_event_json(&to_pairing_sas_event(sas.clone(), hex::encode(peer))).unwrap());
    assert_eq!(json["type"], "pairing.sas");
    assert_eq!(
        json["peerDeviceId"],
        serde_json::json!(hex::encode(joiner_id)),
        "the host needs the id to confirm; an empty id left it unable to"
    );
    assert_eq!(json["sas"], serde_json::json!(sas));
    assert_eq!(sas.len(), 6, "a SAS is six digits");
    let mut keys: Vec<String> = json.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["peerDeviceId", "sas", "type"].map(String::from));
}

#[tokio::test]
async fn a_file_transfer_reaches_js_as_transfer_events() {
    let (joiner, _joiner_db, host, _host_db, _joiner_id, host_id) = paired().await;
    let payload_dir = tempfile::tempdir().unwrap();
    let file = payload_dir.path().join("proof.bin");
    let size = CHUNK_SIZE_DEFAULT as usize * 2;
    std::fs::write(&file, vec![7u8; size]).unwrap();
    let (name, id) = joiner.self_profile().await;
    let (manifest, sources) = from_picked_paths(
        DeviceRef {
            device_id: id,
            name: name.clone(),
        },
        &[file],
        CHUNK_SIZE_DEFAULT,
    )
    .unwrap();
    let mut host_events = host.events();
    let transfer_id = joiner
        .enqueue_outbox_send(host_id, manifest, sources)
        .await
        .unwrap();

    let seen = collect(&mut host_events, |seen| {
        !typed(seen, "transfer.done").is_empty()
    })
    .await;
    let hex_id = hex::encode(transfer_id);

    let progress = typed(&seen, "transfer.progress");
    assert!(
        !progress.is_empty(),
        "the receiving app must see progress; saw {seen:?}"
    );
    let last = progress.last().unwrap();
    assert_eq!(last["transferId"], serde_json::json!(hex_id));
    assert_eq!(
        last["bytesTotal"],
        serde_json::json!(size as u64),
        "the app draws its bar from these two numbers"
    );
    assert_eq!(last["bytesDone"], serde_json::json!(size as u64));
    let done = typed(&seen, "transfer.done");
    assert_eq!(done[0]["transferId"], serde_json::json!(hex_id));
}

#[tokio::test]
async fn an_unpair_reaches_js_as_pairing_revoked() {
    let (joiner, _joiner_db, host, _host_db, joiner_id, host_id) = paired().await;
    // The revoking device is the one whose UI must drop the row, so its own
    // stream is the surface to check. Delivery of the notice to the PEER is
    // covered by daak-core/tests/unpair_notifies_the_peer.rs; this test cannot
    // see it, because a loopback pair with no discovery leaves the revoker with
    // no dialable address for the peer until it announces again.
    let mut host_events = host.events();
    host.revoke_pairing(joiner_id).await.unwrap();
    let seen = collect(&mut host_events, |seen| {
        !typed(seen, "pairing.revoked").is_empty()
    })
    .await;
    let revoked = typed(&seen, "pairing.revoked");
    assert_eq!(
        revoked[0]["deviceId"],
        serde_json::json!(hex::encode(joiner_id)),
        "the row that leaves must be the peer that was removed"
    );
    let _ = (joiner, host_id);
}
