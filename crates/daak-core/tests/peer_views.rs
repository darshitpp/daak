// peer_views is the device list the UI shows. It reads trust from the
// pairings table: trusted is paired, pending and revoked are not.
//
// Binds sockets (Engine start), so it needs an unsandboxed run.

use std::sync::Arc;

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::discovery::beacon::{pairing_presence_key, SealedBeacon};
use daak_core::discovery::presence::{Presence, PresenceState};
use daak_core::engine::{Engine, EngineConfig, EngineEvent, PeerView};
use daak_core::store::pairings::Pairing;
use daak_core::store::Db;

const PEER: [u8; 16] = [5u8; 16];
const PEER_STATIC: [u8; 32] = [2u8; 32];
const PEER_ADDR: &str = "127.0.0.1:9";

fn pairing(state: &str, label: Option<&str>) -> Pairing {
    Pairing {
        peer_device_id: PEER,
        state: state.into(),
        paired_at: 0,
        verify_key: [1u8; 32],
        static_dh_pub: PEER_STATIC,
        label: label.map(str::to_string),
    }
}

fn db() -> Arc<Db> {
    let db = Arc::new(Db::open_in_memory().unwrap());
    db.migrate().unwrap();
    db
}

async fn start(db: Arc<Db>) -> Engine {
    let store = Arc::new(MemorySecretStore::default());
    let identity = import_from_store(store.as_ref()).unwrap();
    Engine::start(EngineConfig {
        display_name: "self".into(),
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        out_dir: std::env::temp_dir(),
        identity,
        db,
    })
    .await
    .unwrap()
}

async fn view(engine: &Engine) -> Option<PeerView> {
    engine
        .peer_views()
        .await
        .unwrap()
        .into_iter()
        .find(|v| v.device_id == PEER)
}

fn away_beacon(engine: &Engine, seq: u64) -> SealedBeacon {
    let key = pairing_presence_key(&engine.identity().static_secret().to_bytes(), &PEER_STATIC);
    let p = Presence {
        device_id: PEER,
        session_id: [0u8; 16],
        name: "peer".into(),
        state: PresenceState::Away,
        seq,
        sent_at_ms: 0,
    };
    SealedBeacon::seal(&p, &key, seq).unwrap()
}

#[tokio::test]
async fn a_trusted_peer_never_seen_appears_offline_with_its_label() {
    let db = db();
    db.upsert_pairing(&pairing("trusted", Some("Kitchen Tablet")))
        .unwrap();
    let engine = start(db).await;
    let v = view(&engine)
        .await
        .expect("a trusted peer is listed without discovery");
    assert!(v.paired);
    assert_eq!(v.name, "Kitchen Tablet");
    assert_eq!(v.addr, None);
    assert_eq!(v.presence, Some(PresenceState::Offline));
}

#[tokio::test]
async fn a_trusted_peer_without_a_label_has_an_empty_name() {
    let db1 = db();
    db1.upsert_pairing(&pairing("trusted", None)).unwrap();
    let engine = start(db1).await;
    assert_eq!(view(&engine).await.unwrap().name, "");

    let db2 = db();
    db2.upsert_pairing(&pairing("trusted", None)).unwrap();
    db2.set_peer_addr(&PEER, PEER_ADDR.parse().unwrap())
        .unwrap();
    let engine = start(db2).await;
    let v = view(&engine).await.unwrap();
    assert_eq!(v.name, "");
    assert_eq!(v.addr, Some(PEER_ADDR.parse().unwrap()));
    assert!(v.paired);
}

#[tokio::test]
async fn a_pending_pairing_is_not_paired_and_has_no_presence() {
    let db = db();
    let engine = start(db.clone()).await;
    // The pending row goes in AFTER `start`, because `Engine::start` runs
    // `reconcile_on_startup`, and that deletes every unconfirmed pending pairing
    // (`store/reconcile.rs`). A row the user never confirmed does not survive
    // the run, so this order is the sequence a real app produces.
    db.upsert_pairing(&pairing("pending", Some("Tablet")))
        .unwrap();
    assert_eq!(view(&engine).await, None);

    engine
        .note_peer(PEER, "Tablet", PEER_ADDR.parse().unwrap())
        .await;
    let v = view(&engine).await.unwrap();
    assert!(!v.paired, "a pending pairing grants nothing");
    assert_eq!(v.presence, None);
    assert_eq!(v.name, "Tablet");

    engine.confirm_pairing(PEER).await.unwrap();
    let v = view(&engine).await.unwrap();
    assert!(v.paired);
    assert_eq!(v.presence, Some(PresenceState::Offline));
}

#[tokio::test]
async fn a_revoked_peer_leaves_the_list_and_returns_only_as_unpaired_or_paired_again() {
    let db = db();
    db.upsert_pairing(&pairing("trusted", Some("Tablet")))
        .unwrap();
    let engine = start(db.clone()).await;
    assert!(view(&engine).await.unwrap().paired);

    engine.revoke_pairing(PEER).await.unwrap();
    assert_eq!(view(&engine).await, None, "a revoked peer is not listed");

    engine
        .note_peer(PEER, "Tablet", PEER_ADDR.parse().unwrap())
        .await;
    let v = view(&engine).await.unwrap();
    assert!(!v.paired);
    assert_eq!(v.presence, None);

    db.upsert_pairing(&pairing("trusted", Some("Tablet")))
        .unwrap();
    let v = view(&engine).await.unwrap();
    assert!(v.paired);
    assert_eq!(v.presence, Some(PresenceState::Offline));
}

#[tokio::test]
async fn an_away_beacon_shows_as_away_and_emits_one_event() {
    let db = db();
    db.upsert_pairing(&pairing("trusted", Some("Tablet")))
        .unwrap();
    let engine = start(db).await;
    let mut events = engine.events();

    engine
        .observe_beacon(&away_beacon(&engine, 1), 1_000)
        .await
        .unwrap();
    assert_eq!(
        view(&engine).await.unwrap().presence,
        Some(PresenceState::Away)
    );

    engine
        .observe_beacon(&away_beacon(&engine, 2), 3_000)
        .await
        .unwrap();
    let mut presence_events = 0;
    while let Ok(ev) = events.try_recv() {
        if matches!(ev, EngineEvent::PeerPresence { device_id, state: PresenceState::Away } if device_id == PEER)
        {
            presence_events += 1;
        }
    }
    assert_eq!(presence_events, 1);
}

#[tokio::test]
async fn a_beacon_from_a_pending_peer_is_ignored() {
    let db = db();
    db.upsert_pairing(&pairing("pending", Some("Tablet")))
        .unwrap();
    let engine = start(db).await;
    assert!(engine
        .observe_beacon(&away_beacon(&engine, 1), 1_000)
        .await
        .unwrap()
        .is_none());
    assert_eq!(view(&engine).await, None);
}

#[tokio::test]
async fn a_revoke_forgets_the_declared_state() {
    let db = db();
    db.upsert_pairing(&pairing("trusted", Some("Tablet")))
        .unwrap();
    let engine = start(db.clone()).await;
    engine
        .observe_beacon(&away_beacon(&engine, 1), 1_000)
        .await
        .unwrap();
    engine.revoke_pairing(PEER).await.unwrap();
    db.upsert_pairing(&pairing("trusted", Some("Tablet")))
        .unwrap();
    assert_eq!(
        view(&engine).await.unwrap().presence,
        Some(PresenceState::Offline)
    );
}
