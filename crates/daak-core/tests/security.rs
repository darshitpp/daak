use daak_core::crypto::identity::Identity;
use daak_core::crypto::noise::session_prologue;
use daak_core::engine::{Engine, EngineConfig, EngineEvent};
use daak_core::manifest::{DeviceRef, Item, Manifest, PayloadKind};
use daak_core::net::secure::{recv_secure_transfer, send_secure_transfer};
use daak_core::net::tcp;
use daak_core::pairing::{pair, PairMode, PairingBundle};
use std::sync::Arc;

fn bundles() -> (Identity, Identity, PairingBundle, PairingBundle) {
    let a = Identity::generate().unwrap();
    let b = Identity::generate().unwrap();
    let ab = PairingBundle::new(a.public(), "a".into());
    let bb = PairingBundle::new(b.public(), "b".into());
    (a, b, ab, bb)
}

#[tokio::test]
async fn both_sides_derive_the_same_sas() {
    let (a, b, a_bundle, b_bundle) = bundles();
    let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();

    let server = {
        let b_bundle = b_bundle.clone();
        let a_bundle = a_bundle.clone();
        tokio::spawn(async move {
            let (mut conn, _) = tcp::accept(&listener).await.unwrap();
            let (_pairing, sas) = pair(
                &mut conn,
                &b,
                &b_bundle,
                &a_bundle,
                false,
                PairMode::Qr,
                None,
            )
            .await
            .unwrap();
            sas
        })
    };

    let mut conn = tcp::dial(addr).await.unwrap();
    let (_pairing, client_sas) = pair(
        &mut conn,
        &a,
        &a_bundle,
        &b_bundle,
        true,
        PairMode::Qr,
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        client_sas,
        server.await.unwrap(),
        "SAS must match on both devices"
    );
    assert_eq!(client_sas.len(), 6);
}

#[tokio::test]
async fn encrypted_transfer_roundtrips_and_writes_file() {
    let (a, b, _ab, _bb) = bundles();
    let a_pub = a.public().x25519;
    let b_pub = b.public().x25519;
    let prologue = session_prologue(&a_pub, &b_pub);
    let _ = &prologue;

    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let path = src.path().join("secret.bin");
    let payload: Vec<u8> = (0..180_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(&path, &payload).unwrap();
    let item = Item::from_file(0, &path, 64 * 1024).unwrap();
    let manifest = Manifest::new(
        PayloadKind::Media,
        DeviceRef {
            device_id: a.device_id(),
            name: "a".into(),
        },
        vec![item],
    );

    let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let dst_path = dst.path().to_path_buf();
    let b_secret = b.static_secret().to_bytes();
    let a_secret = a.static_secret().to_bytes();
    let a_device_id = a.device_id();
    let server = tokio::spawn(async move {
        let (mut conn, _) = tcp::accept(&listener).await.unwrap();
        recv_secure_transfer(
            &mut conn,
            &b_secret,
            &a_pub,
            None,
            &dst_path,
            None,
            |_, _, _, _, _| {},
            |_| {},
        )
        .await
        .unwrap()
    });

    let mut conn = tcp::dial(addr).await.unwrap();
    send_secure_transfer(
        &mut conn,
        &a_secret,
        &b_pub,
        a_device_id,
        &manifest,
        &[Some(path.clone())],
    )
    .await
    .unwrap();

    let got = server.await.unwrap();
    assert_eq!(got.payload_id, manifest.payload_id);
    assert_eq!(
        std::fs::read(dst.path().join("secret.bin")).unwrap(),
        payload
    );
}

async fn engine(_id: u8, name: &str, out: std::path::PathBuf) -> Engine {
    let store = Arc::new(daak_core::crypto::secret_store::MemorySecretStore::default());
    let identity = daak_core::crypto::identity::import_from_store(store.as_ref()).unwrap();
    let db = Arc::new(daak_core::store::Db::open_in_memory().unwrap());
    db.migrate().unwrap();
    Engine::start(EngineConfig {
        display_name: name.into(),
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        out_dir: out,
        identity,
        db,
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn engine_pairs_then_sends_encrypted_file() {
    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    let a = Arc::new(engine(1, "a", d1.path().to_path_buf()).await);
    let b = Arc::new(engine(2, "b", d2.path().to_path_buf()).await);

    let b_addr = b.local_addr();
    let b_bundle = b.pairing_bundle().await;
    let a_id = a.identity().device_id();

    // UI on B has scanned A's QR bundle and offers it to the engine.
    b.offer_pairing(a.pairing_bundle().await, PairMode::Qr, None)
        .await
        .unwrap();

    let b_for_server = b.clone();
    let server = tokio::spawn(async move { b_for_server.accept_pairing_once().await.unwrap() });

    let (client_sas, peer_id) = a.pair_with(b_addr, b_bundle.clone()).await.unwrap();
    let server_sas = server.await.unwrap();
    assert_eq!(client_sas, server_sas);
    assert_eq!(peer_id, b_bundle.identity.device_id);

    let src = tempfile::tempdir().unwrap();
    let path = src.path().join("f.bin");
    std::fs::write(&path, b"engine secret").unwrap();
    let item = Item::from_file(0, &path, 64 * 1024).unwrap();
    let manifest = Manifest::new(
        PayloadKind::Media,
        DeviceRef {
            device_id: a_id,
            name: "a".into(),
        },
        vec![item],
    );

    // The engine accept loop receives over a paired secure session.
    // R-T11-3: send_secure resolves the address from the device map now, and
    // these tests never run discovery, so seed the entry.
    a.note_peer(b_bundle.identity.device_id, "b", b_addr).await;
    a.send_secure(b_bundle.identity.device_id, manifest, vec![Some(path)])
        .await
        .unwrap();

    for _ in 0..50 {
        if d2.path().join("f.bin").exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(
        std::fs::read(d2.path().join("f.bin")).unwrap(),
        b"engine secret"
    );

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

#[tokio::test]
async fn engine_pairs_with_manual_code_then_sends_encrypted_file() {
    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    let a = Arc::new(engine(1, "a", d1.path().to_path_buf()).await);
    let b = Arc::new(engine(2, "b", d2.path().to_path_buf()).await);

    let b_addr = b.local_addr();
    let b_id = b.pairing_bundle().await.identity.device_id;
    let a_id = a.identity().device_id();

    // B (responder) offers a manual code; A (initiator) enters the same code.
    b.offer_code_pairing("123456".into()).await.unwrap();

    let b_for_server = b.clone();
    let server = tokio::spawn(async move { b_for_server.accept_pairing_once().await.unwrap() });

    let (client_sas, peer_id) = a.pair_with_code(b_addr, "123456").await.unwrap();
    let server_sas = server.await.unwrap();
    assert_eq!(client_sas, server_sas);
    assert_eq!(peer_id, b_id);

    let src = tempfile::tempdir().unwrap();
    let path = src.path().join("f.bin");
    std::fs::write(&path, b"code secret").unwrap();
    let item = Item::from_file(0, &path, 64 * 1024).unwrap();
    let manifest = Manifest::new(
        PayloadKind::Media,
        DeviceRef {
            device_id: a_id,
            name: "a".into(),
        },
        vec![item],
    );

    a.note_peer(b_id, "b", b_addr).await;
    a.send_secure(b_id, manifest, vec![Some(path)])
        .await
        .unwrap();

    for _ in 0..50 {
        if d2.path().join("f.bin").exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(
        std::fs::read(d2.path().join("f.bin")).unwrap(),
        b"code secret"
    );

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

#[tokio::test]
async fn mismatched_manual_code_fails() {
    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    let a = Arc::new(engine(1, "a", d1.path().to_path_buf()).await);
    let b = Arc::new(engine(2, "b", d2.path().to_path_buf()).await);

    let b_addr = b.local_addr();
    b.offer_code_pairing("123456".into()).await.unwrap();

    // A different code on the initiator must fail the Noise handshake.
    assert!(a.pair_with_code(b_addr, "654321").await.is_err());

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

#[tokio::test]
async fn engine_reports_transfer_done_for_inbound_file() {
    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    let a = Arc::new(engine(1, "a", d1.path().to_path_buf()).await);
    let b = Arc::new(engine(2, "b", d2.path().to_path_buf()).await);

    let b_addr = b.local_addr();
    let b_bundle = b.pairing_bundle().await;
    let a_id = a.identity().device_id();

    b.offer_pairing(a.pairing_bundle().await, PairMode::Qr, None)
        .await
        .unwrap();

    let b_for_server = b.clone();
    let server = tokio::spawn(async move { b_for_server.accept_pairing_once().await.unwrap() });

    let (client_sas, _peer_id) = a.pair_with(b_addr, b_bundle.clone()).await.unwrap();
    assert_eq!(client_sas, server.await.unwrap());

    let src = tempfile::tempdir().unwrap();
    let path = src.path().join("f.bin");
    std::fs::write(&path, b"engine secret").unwrap();
    let item = Item::from_file(0, &path, 64 * 1024).unwrap();
    let manifest = Manifest::new(
        PayloadKind::Media,
        DeviceRef {
            device_id: a_id,
            name: "a".into(),
        },
        vec![item],
    );
    let payload_id = manifest.payload_id;

    // Subscribe to the receiver's events before sending so the TransferDone
    // broadcast is not dropped for lack of a subscriber.
    let mut events = b.events();

    a.note_peer(b_bundle.identity.device_id, "b", b_addr).await;
    a.send_secure(b_bundle.identity.device_id, manifest, vec![Some(path)])
        .await
        .unwrap();

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match tokio::time::timeout_at(deadline, events.recv()).await {
            Ok(Ok(EngineEvent::TransferDone { transfer_id })) => {
                assert_eq!(transfer_id, payload_id);
                break;
            }
            Ok(Ok(_)) => continue,
            Ok(Err(_)) => panic!("receiver event stream closed before TransferDone"),
            Err(_) => panic!("timed out waiting for TransferDone"),
        }
    }

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

// C1: `inbox.received` had NO PRODUCER anywhere -- EngineEvent had no such
// variant, so the mobile clipboard copy and the receive notification were dead
// code that only looked alive because the JS tests injected the event by hand.
// This drives the REAL inbound receive path (two real Engines, a real pairing,
// a real send) and asserts the event the receiver's own engine emitted carries
// the row that was persisted -- not a hand-built FfiEvent, which only proves
// the serializer.
#[tokio::test]
async fn a_real_inbound_receive_emits_inbox_received_carrying_the_persisted_row() {
    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    let a = Arc::new(engine(1, "a", d1.path().to_path_buf()).await);
    let b = Arc::new(engine(2, "b", d2.path().to_path_buf()).await);

    let b_addr = b.local_addr();
    let b_bundle = b.pairing_bundle().await;
    let a_id = a.identity().device_id();

    b.offer_pairing(a.pairing_bundle().await, PairMode::Qr, None)
        .await
        .unwrap();
    let b_for_server = b.clone();
    let server = tokio::spawn(async move { b_for_server.accept_pairing_once().await.unwrap() });
    let (client_sas, _) = a.pair_with(b_addr, b_bundle.clone()).await.unwrap();
    assert_eq!(client_sas, server.await.unwrap());

    // Text, because the summary the clipboard copies IS the first item's text.
    // Built explicitly, NOT with Manifest::text(): that convenience stamps a
    // ZEROED sender device id, and the assertion below checks the real sender
    // id reaches the row.
    let manifest = Manifest::new(
        PayloadKind::Text,
        DeviceRef {
            device_id: a_id,
            name: "a".into(),
        },
        vec![daak_core::manifest::Item::text(0, "meet at 6")],
    );
    let payload_id = manifest.payload_id;

    // Subscribe BEFORE the send: a broadcast with no receiver drops the event.
    let mut events = b.events();

    a.note_peer(b_bundle.identity.device_id, "b", b_addr).await;
    a.send_secure(b_bundle.identity.device_id, manifest, vec![])
        .await
        .unwrap();

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match tokio::time::timeout_at(deadline, events.recv()).await {
            Ok(Ok(EngineEvent::InboxReceived(row))) => {
                assert_eq!(row.id, payload_id);
                assert_eq!(row.transfer_id, payload_id);
                assert_eq!(row.peer_device_id, a_id, "the SENDER's device id");
                assert_eq!(row.kind, "text");
                assert_eq!(row.item_count, 1);
                assert_eq!(row.summary, "meet at 6");
                assert!(row.received_at > 0);
                // Still the "[]" placeholder (Part B B3 owns the real paths),
                // and the event does not pretend otherwise.
                assert_eq!(row.saved_paths, "[]");

                // The event must carry the row that was PERSISTED, not one the
                // event arm built on its own.
                let stored = b.list_inbox().unwrap();
                assert_eq!(stored.len(), 1);
                assert_eq!(stored[0], row);
                break;
            }
            Ok(Ok(_)) => continue,
            Ok(Err(_)) => panic!("receiver event stream closed before InboxReceived"),
            Err(_) => panic!("timed out waiting for InboxReceived"),
        }
    }

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}
