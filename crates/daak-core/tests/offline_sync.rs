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

// A return inside the flap window is absorbed by the tracker, so no
// StatusChange is emitted. Without a re-announce the UI card stays offline
// while the tracker is online. The engine must re-announce online.
#[tokio::test]
async fn blip_after_offline_reannounces_online() {
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

    let mut events = engine.events();
    // t=0: the peer comes online.
    let first = SealedBeacon::seal(&p, &key, 1).unwrap();
    let change = engine.observe_beacon(&first, 0).await.unwrap();
    assert_eq!(change.map(|c| c.state), Some(Liveness::Online));

    // t=7500: past the 6000 ms timeout, so the heartbeat declares offline.
    let offline = engine.heartbeat(7_500).await;
    assert_eq!(offline.len(), 1, "the peer times out");
    assert_eq!(offline[0].state, Liveness::Offline);

    // t=7600: a fresh beacon inside the 1000 ms flap window. The tracker
    // absorbs the return and observe_beacon returns None.
    let fresh = SealedBeacon::seal(&p, &key, 2).unwrap();
    let change = engine.observe_beacon(&fresh, 7_600).await.unwrap();
    assert!(change.is_none(), "the flap window absorbs the transition");

    let mut saw_online = false;
    for _ in 0..10 {
        match tokio::time::timeout(Duration::from_millis(200), events.recv()).await {
            Ok(Ok(EngineEvent::DeviceState {
                device_id,
                online: true,
            })) if device_id == peer => {
                saw_online = true;
                break;
            }
            Ok(Ok(_)) => continue,
            _ => break,
        }
    }
    assert!(
        saw_online,
        "the engine must re-announce online after an absorbed blip"
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

// Revocation is terminal: the queued row and its staged bytes are purged, the
// pairing is marked revoked, and a later handshake is refused before the Noise
// prologue is built.
#[tokio::test]
async fn revoking_purges_queue_clean_staging_and_blocks_reconnect() {
    use daak_core::manifest::{DeviceRef, Item, Manifest, CHUNK_SIZE_DEFAULT};
    use daak_core::outbox::enqueue;
    use daak_core::staging::Staging;

    let db = Arc::new(Db::open_in_memory().unwrap());
    db.migrate().unwrap();
    let peer = [6u8; 16];
    db.upsert_pairing(&Pairing {
        peer_device_id: peer,
        state: "trusted".into(),
        paired_at: 0,
        verify_key: [1u8; 32],
        static_dh_pub: [2u8; 32],
        label: None,
    })
    .unwrap();

    // The engine builds its staging root as out_dir / "staging", so the test
    // stages into the SAME tree the engine's revoke will clean.
    let staging_root = tempfile::tempdir().unwrap();
    let out_dir = staging_root.path().to_path_buf();
    let staging = Staging::new(out_dir.join("staging"));

    // A REAL file, so the payload dir exists and cleanup must remove it.
    let src = tempfile::tempdir().unwrap();
    let file = src.path().join("payload.bin");
    std::fs::write(&file, b"staged bytes").unwrap();
    let item = Item::from_file(0, &file, CHUNK_SIZE_DEFAULT).unwrap();
    let manifest = Manifest::batch(
        DeviceRef {
            device_id: [0u8; 16],
            name: "local".into(),
        },
        vec![item],
    )
    .unwrap();
    let payload_id = manifest.payload_id;
    enqueue(&db, &staging, &peer, &manifest, &[file]).unwrap();

    let staged_dir = out_dir.join("staging").join(hex16(&payload_id));
    assert!(
        staged_dir.exists(),
        "a real file is staged before the revoke"
    );
    assert_eq!(db.due_outbox_for_peer(&peer, i64::MAX).unwrap().len(), 1);

    let store = Arc::new(daak_core::crypto::secret_store::MemorySecretStore::default());
    let identity = daak_core::crypto::identity::import_from_store(store.as_ref()).unwrap();
    let engine = Engine::start(EngineConfig {
        display_name: "self".into(),
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        out_dir,
        identity,
        db: db.clone(),
    })
    .await
    .unwrap();

    let before = db.list_transfers(None, Some(&peer)).unwrap();
    assert_eq!(
        before.len(),
        1,
        "enqueue writes one transfers row for the peer"
    );
    let state_before = before[0].state.clone();
    eprintln!("transfers state before revoke: {state_before}");

    engine.revoke_pairing(peer).await.unwrap();

    assert!(db.is_revoked(&peer).unwrap(), "pairing state is revoked");
    assert!(
        db.due_outbox_for_peer(&peer, i64::MAX).unwrap().is_empty(),
        "queue purged"
    );
    assert!(!staged_dir.exists(), "staging cleaned");
    assert!(
        engine.connection_allowed(&peer).await.is_err(),
        "reconnect refused"
    );

    // Revoke KEEPS the transfers row and CANCELS it. The plan expected the row
    // to stay `queued`; it does not. P1 Task 3 (`cancel_outbound_for_peer`)
    // moves every open outbound row of a revoked peer to `canceled` in the
    // same call, so the row is kept and its state changes. Measured here on
    // 2026-10-10: before `queued`, after `canceled`.
    let kept = db.list_transfers(None, Some(&peer)).unwrap();
    assert_eq!(kept.len(), 1, "revoke keeps the transfers row");
    assert_eq!(
        state_before, "queued",
        "enqueue did not leave the row queued"
    );
    assert_eq!(kept[0].state, "canceled", "revoke cancels the kept row");
    eprintln!("transfers state after revoke: {}", kept[0].state);
    // HEAD 824b3d7: the peer is not on the network here, so the engine keeps an
    // unpair notice and delivers it when the peer returns. Remove must stay
    // possible for an offline device, and this line records why it is safe.
    assert!(
        db.has_unpair_notice(&peer),
        "an undelivered unpair notice is kept"
    );

    engine.shutdown().await.unwrap();
}

fn hex16(b: &[u8; 16]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
