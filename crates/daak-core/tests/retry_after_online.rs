// A queued send must start soon after the peer comes online. These tests
// model two delays that a user saw: a Mac sends to an Android app that is in
// the background, and the send starts 1 to 2 minutes after the app opens.
//
// The test models a try that hangs while the peer comes online.
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use daak_core::discovery::beacon::{pairing_presence_key, SealedBeacon};
use daak_core::discovery::presence::{Presence, PresenceState};
use daak_core::engine::{Engine, EngineConfig};
use daak_core::manifest::Manifest;
use daak_core::outbox::enqueue;
use daak_core::staging::Staging;
use daak_core::store::pairings::Pairing;
use daak_core::store::Db;

const PEER: [u8; 16] = [5u8; 16];

fn paired_db() -> Arc<Db> {
    let db = Arc::new(Db::open_in_memory().unwrap());
    db.migrate().unwrap();
    db.upsert_pairing(&Pairing {
        peer_device_id: PEER,
        state: "trusted".into(),
        paired_at: 0,
        verify_key: [1u8; 32],
        static_dh_pub: [2u8; 32],
        label: None,
    })
    .unwrap();
    db
}

async fn start(db: &Arc<Db>) -> Engine {
    let store = Arc::new(daak_core::crypto::secret_store::MemorySecretStore::default());
    let identity = daak_core::crypto::identity::import_from_store(store.as_ref()).unwrap();
    Engine::start(EngineConfig {
        display_name: "self".into(),
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        out_dir: std::env::temp_dir(),
        identity,
        db: db.clone(),
    })
    .await
    .unwrap()
}

fn online_beacon(engine: &Engine, seq: u64) -> SealedBeacon {
    let key = pairing_presence_key(&engine.identity().static_secret().to_bytes(), &[2u8; 32]);
    let p = Presence {
        device_id: PEER,
        session_id: [0u8; 16],
        name: "peer".into(),
        state: PresenceState::Online,
        seq,
        sent_at_ms: 0,
    };
    SealedBeacon::seal(&p, &key, seq).unwrap()
}

// The peer is a socket that accepts the connection and never answers. This
// models an app that Android froze. The first try hangs until the handshake
// deadline (15 s). The peer comes online during that try. The second try must
// start soon after the first try fails, not after the whole backoff.
// This test takes about 20 s. It runs with a plain `cargo test`.
//   cargo test -p daak-core --test retry_after_online -- --nocapture
#[tokio::test]
async fn a_try_that_hangs_while_the_peer_comes_online_is_retried_soon() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let accepts = Arc::new(AtomicUsize::new(0));
    let times: Arc<Mutex<Vec<Instant>>> = Arc::new(Mutex::new(Vec::new()));
    {
        let accepts = accepts.clone();
        let times = times.clone();
        tokio::spawn(async move {
            let mut held = Vec::new();
            loop {
                let Ok((sock, _)) = listener.accept().await else {
                    return;
                };
                accepts.fetch_add(1, Ordering::SeqCst);
                times.lock().unwrap().push(Instant::now());
                held.push(sock); // Hold the socket open. Never answer.
            }
        });
    }

    let db = paired_db();
    db.set_peer_addr(&PEER, addr).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let staging = Staging::new(dir.path().to_path_buf());
    enqueue(&db, &staging, &PEER, &Manifest::text("queued"), &[]).unwrap();

    let engine = start(&db).await;
    let t0 = Instant::now();

    // Wait for the first try, then bring the peer online 2 s later.
    while accepts.load(Ordering::SeqCst) < 1 {
        assert!(t0.elapsed() < Duration::from_secs(20), "no first try");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tokio::time::sleep(Duration::from_secs(2)).await;
    let beacon = online_beacon(&engine, 1);
    let change = engine.observe_beacon(&beacon, 1_000).await.unwrap();
    assert!(change.is_some(), "the peer changes from offline to online");
    let online_at = Instant::now();

    while accepts.load(Ordering::SeqCst) < 2 {
        assert!(
            online_at.elapsed() < Duration::from_secs(120),
            "no second try in 120 s"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let second = times.lock().unwrap()[1];
    let wait = second.duration_since(online_at);
    println!("second try started {:?} after the online change", wait);
    assert!(
        wait <= Duration::from_secs(25),
        "the second try started {wait:?} after the peer came online"
    );
    engine.shutdown().await.unwrap();
}
