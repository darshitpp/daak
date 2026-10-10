// A pairing is pending until this device confirms it, so the SAS compare gates
// trust. See docs/superpowers/specs/2026-10-09-pairing-confirmation.md.
//
// Binds sockets, so it needs an unsandboxed run.

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::engine::{Engine, EngineConfig, EngineEvent};
use daak_core::pairing::PairMode;
use daak_core::store::Db;
use std::path::PathBuf;
use std::sync::Arc;

async fn engine(name: &str, out: PathBuf, db: Arc<Db>) -> Arc<Engine> {
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

struct Pair {
    joiner: Arc<Engine>,
    joiner_db: Arc<Db>,
    host: Arc<Engine>,
    host_db: Arc<Db>,
    joiner_id: [u8; 16],
    host_id: [u8; 16],
}

/// Pairs two gated engines over loopback. Neither side has confirmed.
async fn gated_pair() -> Pair {
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
        async move { host.accept_pairing_once().await.unwrap() }
    });
    joiner
        .pair_with(host.local_addr(), host.pairing_bundle().await)
        .await
        .unwrap();
    accept.await.unwrap();
    Pair {
        joiner,
        joiner_db,
        host,
        host_db,
        joiner_id,
        host_id,
    }
}

fn state(db: &Db, id: &[u8; 16]) -> Option<String> {
    db.get_pairing(id).unwrap().map(|p| p.state)
}

// The host's own SAS confirmation needs the peer id, and the id exists only at
// the moment the SAS arrives. Without it the host app renders no confirm
// control, so a host-initiated pairing never becomes trusted on the host.
#[tokio::test]
async fn the_host_learns_the_joiner_id_with_the_sas() {
    let (d1, d2) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (joiner_db, host_db) = (db(), db());
    let joiner = engine("joiner", d1.keep(), joiner_db.clone()).await;
    let host = engine("host", d2.keep(), host_db.clone()).await;
    joiner.set_pairing_confirmation_required(true);
    host.set_pairing_confirmation_required(true);
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

    assert_eq!(
        peer, joiner_id,
        "the host must learn the joiner id together with the SAS"
    );
    assert_eq!(sas.len(), 6, "a SAS is six digits");

    // The id is the handle the app confirms with, and confirming makes the
    // host trust the peer.
    host.confirm_pairing(peer).await.unwrap();
    assert!(host_db.is_trusted(&joiner_id));
}

#[tokio::test]
async fn an_unconfirmed_pairing_is_pending_and_grants_no_trust() {
    let (d1, d2) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (joiner_db, host_db) = (db(), db());
    let joiner = engine("joiner", d1.keep(), joiner_db.clone()).await;
    let host = engine("host", d2.keep(), host_db.clone()).await;
    joiner.set_pairing_confirmation_required(true);
    host.set_pairing_confirmation_required(true);
    let mut host_events = host.events();
    let mut joiner_events = joiner.events();
    let joiner_id = joiner.pairing_bundle().await.identity.device_id;
    let host_id = host.pairing_bundle().await.identity.device_id;
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

    assert_eq!(state(&host_db, &joiner_id).as_deref(), Some("pending"));
    assert_eq!(state(&joiner_db, &host_id).as_deref(), Some("pending"));
    assert!(!host_db.is_trusted(&joiner_id));
    assert!(!joiner_db.is_trusted(&host_id));
    let listed = host.devices().await;
    assert!(
        listed.iter().all(|d| !d.paired),
        "a pending peer must not read as paired"
    );
    for rx in [&mut host_events, &mut joiner_events] {
        while let Ok(ev) = rx.try_recv() {
            assert!(
                !matches!(ev, EngineEvent::PairingDone { .. }),
                "no pairing.done before the user confirms"
            );
        }
    }
}

#[tokio::test]
async fn confirming_makes_the_pairing_trusted_and_says_so() {
    let p = gated_pair().await;
    let mut events = p.joiner.events();

    p.joiner.confirm_pairing(p.host_id).await.unwrap();

    assert_eq!(state(&p.joiner_db, &p.host_id).as_deref(), Some("trusted"));
    assert!(
        p.joiner
            .devices()
            .await
            .iter()
            .any(|d| d.device_id == p.host_id && d.paired),
        "a confirmed peer reads as paired"
    );
    let mut done = false;
    while let Ok(ev) = events.try_recv() {
        if matches!(ev, EngineEvent::PairingDone { device_id } if device_id == p.host_id) {
            done = true;
        }
    }
    assert!(done, "confirming emits PairingDone");
    // The other side has not confirmed, so it still trusts nobody.
    assert_eq!(state(&p.host_db, &p.joiner_id).as_deref(), Some("pending"));
}

#[tokio::test]
async fn confirming_with_nothing_pending_is_an_error() {
    let p = gated_pair().await;
    p.joiner.confirm_pairing(p.host_id).await.unwrap();
    assert!(
        p.joiner.confirm_pairing(p.host_id).await.is_err(),
        "a trusted pairing has nothing to confirm"
    );
    assert!(p.joiner.confirm_pairing([9u8; 16]).await.is_err());
}

#[tokio::test]
async fn rejecting_a_pending_pairing_lets_the_same_device_pair_again() {
    let p = gated_pair().await;
    p.joiner.revoke_pairing(p.host_id).await.unwrap();
    assert_eq!(state(&p.joiner_db, &p.host_id).as_deref(), Some("revoked"));

    // The host never confirmed either, and it is armed again.
    p.host.offer_inbound_pairing(PairMode::Qr).await.unwrap();
    let accept = tokio::spawn({
        let host = p.host.clone();
        async move { host.accept_pairing_once().await.unwrap() }
    });
    p.joiner
        .pair_with(p.host.local_addr(), p.host.pairing_bundle().await)
        .await
        .expect("a rejected pairing must not block the next attempt");
    accept.await.unwrap();
}

#[tokio::test]
async fn start_drops_a_pending_pairing_nobody_confirmed() {
    let p = gated_pair().await;
    let dir = tempfile::tempdir().unwrap();
    // A fresh engine on the host's database: the pending row is from a run that
    // ended before the user answered.
    p.host.shutdown().await.unwrap();
    let restarted = engine("host", dir.keep(), p.host_db.clone()).await;
    assert!(
        state(&p.host_db, &p.joiner_id).is_none(),
        "an abandoned pending pairing must not survive a restart"
    );
    assert!(restarted.devices().await.iter().all(|d| !d.paired));
}
