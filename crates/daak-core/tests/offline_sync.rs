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

// The phase exit criterion: three payloads queue while the peer is away, the
// peer returns, and every queued row drains exactly once.
#[tokio::test]
async fn peer_offline_mid_queue_then_online_drains_without_duplication() {
    use daak_core::discovery::status::{PresenceConfig, PresenceTracker};
    use daak_core::manifest::Manifest;
    use daak_core::outbox::enqueue;
    use daak_core::staging::Staging;

    let db = Arc::new(Db::open_in_memory().unwrap());
    db.migrate().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let staging = Staging::new(dir.path().to_path_buf());
    let peer = [7u8; 16];

    // Three queued payloads while the peer is offline.
    let mut ids = Vec::new();
    for i in 0..3u8 {
        let m = Manifest::text(&format!("queued {i}"));
        ids.push(enqueue(&db, &staging, &peer, &m, &[]).unwrap());
    }

    // Every attempt fails while offline: rows back off and are not due. The
    // real state machine only backs off a row that is 'sending' first.
    for id in &ids {
        assert!(db.mark_outbox_sending(id).unwrap());
        db.mark_outbox_failed(id, 0, 0).unwrap();
    }
    assert!(
        db.due_outbox_for_peer(&peer, 29).unwrap().is_empty(),
        "rows are backing off"
    );

    // Presence goes online, then the peer drops mid-queue.
    let mut tracker = PresenceTracker::new(PresenceConfig::default());
    assert_eq!(
        tracker.observe(peer, 1, 1_000).map(|c| c.state),
        Some(Liveness::Online)
    );
    assert_eq!(tracker.tick(5_000).len(), 0);
    assert_eq!(tracker.tick(7_500).len(), 1, "peer goes offline mid-queue");

    // Peer returns: a successful connect resets backoff for every pending row.
    // retry_outbox_now stamps the REAL clock, so due-ness is asked at the far
    // future, not at a small now.
    for id in &ids {
        assert!(db.retry_outbox_now(id).unwrap());
    }
    let due = db.due_outbox_for_peer(&peer, i64::MAX).unwrap();
    assert_eq!(due.len(), 3, "every pending row is promoted on reconnect");

    // Drain exactly once per row; a second pass has nothing left to do.
    for row in due {
        db.mark_outbox_sending(&row.id).unwrap();
        db.mark_outbox_awaiting_ack(&row.id).unwrap();
        db.mark_outbox_done(&row.id).unwrap();
    }
    assert!(db.due_outbox_for_peer(&peer, i64::MAX).unwrap().is_empty());
    let done = db.list_outbox_for_peer(&peer).unwrap();
    assert_eq!(done.len(), 3);
    assert!(
        done.iter().all(|r| r.state == "done"),
        "no row is left pending or duplicated"
    );
}
