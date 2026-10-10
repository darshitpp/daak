// A revoke must not leave a queued send waiting for ever.
//
// Revoke pairing purges the outbox rows of the peer, and the matching
// transfers rows of direction out used to stay queued. The thread then showed
// an item that could never move, and Stop and Retry failed because no outbox
// row existed. The rows stay as history, but the open outbound ones now read
// canceled.
//
// Binds sockets, so it needs an unsandboxed run.

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::engine::{Engine, EngineConfig};
use daak_core::manifest::Manifest;
use daak_core::pairing::PairMode;
use daak_core::store::Db;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

struct Side {
    engine: Arc<Engine>,
    db: Arc<Db>,
    store: Arc<MemorySecretStore>,
}

async fn start(
    name: &str,
    out: PathBuf,
    db: Arc<Db>,
    store: Arc<MemorySecretStore>,
) -> Arc<Engine> {
    Arc::new(
        Engine::start(EngineConfig {
            display_name: name.into(),
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            out_dir: out,
            identity: import_from_store(store.as_ref()).unwrap(),
            db,
        })
        .await
        .unwrap(),
    )
}

async fn side(name: &str) -> Side {
    let db = Arc::new(Db::open_in_memory().unwrap());
    db.migrate().unwrap();
    let store = Arc::new(MemorySecretStore::default());
    let out = tempfile::tempdir().unwrap().keep();
    let engine = start(name, out, db.clone(), store.clone()).await;
    Side { engine, db, store }
}

async fn pair(joiner: &Engine, host: &Arc<Engine>) {
    host.offer_inbound_pairing(PairMode::Qr).await.unwrap();
    let accept = tokio::spawn({
        let host = host.clone();
        async move { host.accept_pairing_once().await.unwrap() }
    });
    joiner
        .pair_with(host.local_addr(), host.pairing_bundle().await)
        .await
        .unwrap();
    accept.await.unwrap();
}

async fn wait_until(what: &str, secs: u64, mut ok: impl FnMut() -> bool) {
    let poll = async {
        while !ok() {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(secs), poll)
        .await
        .unwrap_or_else(|_| panic!("{what}"));
}

fn notice_key(peer: &[u8; 16]) -> String {
    format!("unpair_notice:{}", hex::encode(peer))
}

#[tokio::test]
async fn a_revoke_cancels_the_queued_send_and_keeps_the_thread() {
    let joiner = side("joiner").await;
    let host = side("host").await;
    let host_id = host.engine.pairing_bundle().await.identity.device_id;
    pair(&joiner.engine, &host.engine).await;
    host.engine.shutdown().await.unwrap();

    let payload = joiner
        .engine
        .enqueue_outbox_send(host_id, Manifest::text("waiting"), vec![])
        .await
        .unwrap();
    let before = joiner.db.get_transfer(&payload).unwrap().unwrap();
    assert!(
        matches!(before.state.as_str(), "queued" | "active" | "awaiting_ack"),
        "the send is open before the revoke, got {}",
        before.state
    );

    joiner.engine.revoke_pairing(host_id).await.unwrap();

    let rows = joiner.engine.list_transfers(None, Some(host_id)).unwrap();
    assert_eq!(rows.len(), 1, "the row stays as history");
    assert_eq!(rows[0].state, "canceled");
    assert_eq!(rows[0].error.as_deref(), Some("unpaired"));
    assert!(joiner.db.list_outbox_for_peer(&host_id).unwrap().is_empty());
    assert!(joiner.db.has_unpair_notice(&host_id));

    let page = joiner.engine.list_thread(host_id, 50, None).unwrap();
    assert_eq!(page.items.len(), 1);
    assert!(page.items[0].outbound);
    assert_eq!(page.items[0].text.as_deref(), Some("waiting"));
    assert_eq!(page.items[0].transfer_state, "canceled");
    assert_eq!(page.items[0].state, "failed");

    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        joiner.db.get_transfer(&payload).unwrap().unwrap().state,
        "canceled"
    );
}

#[tokio::test]
async fn after_a_new_pairing_a_new_send_works_and_the_old_rows_stay_canceled() {
    let joiner = side("joiner").await;
    let host = side("host").await;
    let host_id = host.engine.pairing_bundle().await.identity.device_id;
    let joiner_id = joiner.engine.pairing_bundle().await.identity.device_id;
    pair(&joiner.engine, &host.engine).await;
    host.engine.shutdown().await.unwrap();
    drop(host.engine);

    let first = joiner
        .engine
        .enqueue_outbox_send(host_id, Manifest::text("one"), vec![])
        .await
        .unwrap();
    joiner.engine.revoke_pairing(host_id).await.unwrap();
    assert_eq!(
        joiner.db.get_transfer(&first).unwrap().unwrap().state,
        "canceled"
    );

    let host_engine = start(
        "host",
        tempfile::tempdir().unwrap().keep(),
        host.db.clone(),
        host.store.clone(),
    )
    .await;
    joiner
        .engine
        .note_peer(host_id, "host", host_engine.local_addr())
        .await;
    wait_until("the host must receive the notice", 5, || {
        host.db
            .get_pairing(&joiner_id)
            .unwrap()
            .is_some_and(|p| p.state == "revoked")
            && joiner
                .db
                .get_setting(&notice_key(&host_id))
                .unwrap()
                .is_none()
    })
    .await;

    pair(&joiner.engine, &host_engine).await;
    let second = joiner
        .engine
        .enqueue_outbox_send(host_id, Manifest::text("two"), vec![])
        .await
        .unwrap();
    wait_until("the new send must be delivered", 45, || {
        joiner
            .db
            .get_outbox(&second)
            .unwrap()
            .is_some_and(|r| r.state == "done")
    })
    .await;

    let old = joiner.db.get_transfer(&first).unwrap().unwrap();
    assert_eq!(old.state, "canceled", "the old row stays canceled");
    assert_eq!(old.error.as_deref(), Some("unpaired"));
    let new = joiner.db.get_transfer(&second).unwrap().unwrap();
    assert_ne!(new.state, "canceled");
    assert_eq!(
        joiner
            .engine
            .list_transfers(None, Some(host_id))
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn a_revoke_by_the_peer_also_cancels_the_queued_send() {
    let joiner = side("joiner").await;
    let host = side("host").await;
    let host_id = host.engine.pairing_bundle().await.identity.device_id;
    let joiner_id = joiner.engine.pairing_bundle().await.identity.device_id;
    pair(&joiner.engine, &host.engine).await;
    host.engine.shutdown().await.unwrap();
    drop(host.engine);

    let payload = joiner
        .engine
        .enqueue_outbox_send(host_id, Manifest::text("waiting"), vec![])
        .await
        .unwrap();

    let host_engine = start(
        "host",
        tempfile::tempdir().unwrap().keep(),
        host.db.clone(),
        host.store.clone(),
    )
    .await;
    host_engine
        .note_peer(joiner_id, "joiner", joiner.engine.local_addr())
        .await;
    host_engine.revoke_pairing(joiner_id).await.unwrap();

    wait_until("the joiner must revoke when told", 5, || {
        joiner
            .db
            .get_pairing(&host_id)
            .unwrap()
            .is_some_and(|p| p.state == "revoked")
    })
    .await;
    let row = joiner.db.get_transfer(&payload).unwrap().unwrap();
    assert_eq!(row.state, "canceled");
    assert_eq!(row.error.as_deref(), Some("unpaired"));
}
