// The bounded, time-limited pairing code: three tries, a 120 s TTL, and a
// status the host screen polls. See task 1 of the code pairing work.
//
// Binds sockets, so it needs an unsandboxed run.

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::engine::{CodePairingState, Engine, EngineConfig};
use daak_core::store::Db;
use std::sync::Arc;
use std::time::Duration;

async fn engine(name: &str) -> Arc<Engine> {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(MemorySecretStore::default());
    let identity = import_from_store(store.as_ref()).unwrap();
    let db = Arc::new(Db::open_in_memory().unwrap());
    db.migrate().unwrap();
    Arc::new(
        Engine::start(EngineConfig {
            display_name: name.into(),
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            out_dir: dir.keep(),
            identity,
            db,
        })
        .await
        .unwrap(),
    )
}

/// Wait until the host slot reports `want`, or the deadline passes.
///
/// The failed handshake clears the slot on the HOST task, and the joiner
/// returns before that write lands. A fixed sleep is a timing bet: a loaded
/// machine can take longer than any constant. The poll returns the last state,
/// so the assertion still names the real value.
async fn wait_for_state(host: &Engine, want: CodePairingState) -> CodePairingState {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        let state = host.code_pairing_status().await.state;
        if state == want || tokio::time::Instant::now() >= deadline {
            return state;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn the_code_survives_two_wrong_tries_and_pairs_on_the_third() {
    let host = engine("host").await;
    host.offer_code_pairing("123456".into()).await.unwrap();
    for _ in 0..2 {
        let joiner = engine("joiner").await;
        assert!(joiner
            .pair_with_code(host.local_addr(), "000000")
            .await
            .is_err());
    }
    assert_eq!(
        host.code_pairing_status().await.state,
        CodePairingState::Armed
    );

    let accept = tokio::spawn({
        let h = host.clone();
        async move { h.accept_pairing_once().await }
    });
    let joiner = engine("joiner").await;
    joiner
        .pair_with_code(host.local_addr(), "123456")
        .await
        .unwrap();
    accept.await.unwrap().unwrap();
}

// F7: a leading-zero code stays a string end to end. `007341` must not read as
// `7341`, so the same string still pairs through SPAKE2. `format_code` proves
// the formatting; this walks the string through the real handshake.
#[tokio::test]
async fn a_leading_zero_code_pairs_end_to_end() {
    let host = engine("host").await;
    host.offer_code_pairing("007341".into()).await.unwrap();
    let accept = tokio::spawn({
        let h = host.clone();
        async move { h.accept_pairing_once().await }
    });
    let joiner = engine("joiner").await;
    joiner
        .pair_with_code(host.local_addr(), "007341")
        .await
        .unwrap();
    accept.await.unwrap().unwrap();
}

#[tokio::test]
async fn the_code_is_gone_after_three_wrong_tries() {
    let host = engine("host").await;
    host.offer_code_pairing("123456".into()).await.unwrap();
    for _ in 0..3 {
        let joiner = engine("joiner").await;
        let _ = joiner.pair_with_code(host.local_addr(), "000000").await;
    }
    // The failed third handshake clears the slot on the HOST task, and the
    // joiner returns before that write lands. Wait for the host to settle.
    assert_eq!(
        wait_for_state(&host, CodePairingState::Exhausted).await,
        CodePairingState::Exhausted
    );
}

// The host poll must show the expiry with NO connection.
#[tokio::test]
async fn the_code_expires_after_its_ttl() {
    let host = engine("host").await;
    host.offer_code_pairing_with_ttl("123456".into(), Duration::from_millis(50))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(
        host.code_pairing_status().await.state,
        CodePairingState::Expired
    );
    let joiner = engine("joiner").await;
    assert!(joiner
        .pair_with_code(host.local_addr(), "123456")
        .await
        .is_err());
}

// Smoke test. The cap itself is proven deterministically by the `reserve` unit
// test above; this only shows ten at once do not break the host.
#[tokio::test]
async fn ten_concurrent_guesses_do_not_pair_and_the_slot_is_closed() {
    let host = engine("host").await;
    host.offer_code_pairing("123456".into()).await.unwrap();
    let mut joins = Vec::new();
    for _ in 0..10 {
        let joiner = engine("joiner").await;
        let addr = host.local_addr();
        joins.push(tokio::spawn(async move {
            joiner.pair_with_code(addr, "000000").await.is_ok()
        }));
    }
    for j in joins {
        assert!(!j.await.unwrap(), "no wrong code may pair");
    }
    // The ten joins race the host's own clear, so wait for it to land.
    assert_eq!(
        wait_for_state(&host, CodePairingState::Exhausted).await,
        CodePairingState::Exhausted
    );
}

// The Db is not reachable from Engine, so this reads the pending state through
// Engine::peer_views, which reads trust from the pairings table.
#[tokio::test]
async fn a_code_pairing_stays_pending_until_the_user_confirms() {
    let host = engine("host").await;
    host.set_pairing_confirmation_required(true);
    host.offer_code_pairing("123456".into()).await.unwrap();
    let accept = tokio::spawn({
        let h = host.clone();
        async move { h.accept_pairing_once_with_peer().await }
    });
    let joiner = engine("joiner").await;
    joiner
        .pair_with_code(host.local_addr(), "123456")
        .await
        .unwrap();
    let (_host_sas, joiner_id) = accept.await.unwrap().unwrap();

    let unconfirmed = host
        .peer_views()
        .await
        .unwrap()
        .into_iter()
        .find(|v| v.device_id == joiner_id)
        .expect("the joiner must be listed");
    assert!(!unconfirmed.paired, "an unconfirmed pairing grants nothing");

    host.confirm_pairing(joiner_id).await.unwrap();
    let confirmed = host
        .peer_views()
        .await
        .unwrap()
        .into_iter()
        .find(|v| v.device_id == joiner_id)
        .expect("the joiner must still be listed");
    assert!(confirmed.paired);
}
