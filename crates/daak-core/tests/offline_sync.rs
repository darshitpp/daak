use std::sync::Arc;
use std::time::Duration;

use daak_core::discovery::beacon::{pairing_presence_key, SealedBeacon};
use daak_core::discovery::presence::{Presence, PresenceState};
use daak_core::discovery::status::Liveness;
use daak_core::engine::{Engine, EngineConfig, EngineEvent};
use daak_core::store::pairings::Pairing;
use daak_core::store::Db;

#[tokio::test]
async fn engine_reports_online_then_offline_state() {
    let db = Arc::new(Db::open_in_memory().unwrap());
    db.migrate().unwrap();
    let peer = [5u8; 16];
    db.upsert_pairing(&Pairing {
        peer_device_id: peer,
        state: "trusted".into(),
        paired_at: 0,
        verify_key: [1u8; 32],
        static_dh_pub: [2u8; 32],
        label: None,
    })
    .unwrap();

    let store = Arc::new(daak_core::crypto::secret_store::MemorySecretStore::default());
    let identity = daak_core::crypto::identity::import_from_store(store.as_ref()).unwrap();
    let engine = Engine::start(EngineConfig {
        display_name: "self".into(),
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        out_dir: std::env::temp_dir(),
        identity,
        db: db.clone(),
    })
    .await
    .unwrap();

    let key = pairing_presence_key(&engine.identity().static_secret().to_bytes(), &[2u8; 32]);
    let p = Presence {
        device_id: peer,
        session_id: [0u8; 16],
        name: "peer".into(),
        state: PresenceState::Online,
        seq: 1,
        sent_at_ms: 0,
    };
    let beacon = SealedBeacon::seal(&p, &key, 1).unwrap();

    let mut events = engine.events();
    let change = engine.observe_beacon(&beacon, 1_000).await.unwrap();
    assert_eq!(change.map(|c| c.state), Some(Liveness::Online));
    let _ = engine.heartbeat(7_500).await;

    let mut saw_online = false;
    let mut saw_offline = false;
    for _ in 0..10 {
        match tokio::time::timeout(Duration::from_millis(200), events.recv()).await {
            Ok(Ok(EngineEvent::DeviceState { online: true, .. })) => saw_online = true,
            Ok(Ok(EngineEvent::DeviceState { online: false, .. })) => saw_offline = true,
            Ok(Ok(_)) => continue,
            _ => break,
        }
        if saw_online && saw_offline {
            break;
        }
    }
    assert!(
        saw_online && saw_offline,
        "both transitions must reach the event bus"
    );
    engine.shutdown().await.unwrap();
}
