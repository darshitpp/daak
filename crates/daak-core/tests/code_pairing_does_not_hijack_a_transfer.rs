// An armed code must not hijack a transfer from a peer the host already
// trusts. An ordinary transfer looks like a pairing dial up to the first frame
// after the Hello, so the code branch used to read that frame as an identity,
// fail, and kill the transfer.
//
// Binds sockets, so it needs an unsandboxed run.

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::engine::{CodePairingState, Engine, EngineConfig};
use daak_core::manifest::{DeviceRef, Manifest};
use daak_core::store::Db;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

async fn engine(name: &str, out: PathBuf) -> Arc<Engine> {
    let store = Arc::new(MemorySecretStore::default());
    let identity = import_from_store(store.as_ref()).unwrap();
    let db = Arc::new(Db::open_in_memory().unwrap());
    db.migrate().unwrap();
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

/// Wait until the host has recorded a done inbound transfer of the given kind.
async fn host_received(host: &Engine, kind: &str) {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let seen = host
                .list_transfers(Some("done"), None)
                .unwrap_or_default()
                .into_iter()
                .any(|r| r.direction == "in" && r.kind == kind);
            if seen {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the host never recorded a done inbound transfer");
}

#[tokio::test]
async fn an_armed_code_does_not_hijack_a_transfer_from_a_paired_peer() {
    let (hdir, jdir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let host = engine("host", hdir.path().to_path_buf()).await;
    let joiner = engine("joiner", jdir.path().to_path_buf()).await;

    // Pair once through the code flow, so both sides hold a trusted row.
    host.offer_code_pairing("123456".into()).await.unwrap();
    let accept = tokio::spawn({
        let host = host.clone();
        async move { host.accept_pairing_once().await.unwrap() }
    });
    joiner
        .pair_with_code(host.local_addr(), "123456")
        .await
        .unwrap();
    accept.await.unwrap();

    // Arm a SECOND code, then have the already-paired peer send a transfer
    // during the arm window.
    host.offer_code_pairing("654321".into()).await.unwrap();

    let (join_name, join_id) = joiner.self_profile().await;
    let mut manifest = Manifest::text("over an armed code");
    manifest.sender = DeviceRef {
        device_id: join_id,
        name: join_name,
    };
    let host_id = host.pairing_bundle().await.identity.device_id;
    joiner
        .enqueue_outbox_send(host_id, manifest, vec![])
        .await
        .unwrap();

    host_received(&host, "text").await;

    // The transfer must not have touched the armed code.
    let status = host.code_pairing_status().await;
    assert_eq!(status.state, CodePairingState::Armed);
    assert_eq!(status.tries_left, 3);
}
