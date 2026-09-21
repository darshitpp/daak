use daak_core::crypto::identity::Identity;
use daak_core::crypto::noise::session_prologue;
use daak_core::engine::{Engine, EngineConfig};
use daak_core::manifest::{DeviceRef, Item, Manifest, PayloadKind};
use daak_core::net::secure::{recv_secure_transfer, send_secure_transfer};
use daak_core::net::tcp;
use daak_core::pairing::{pair, PairingBundle};
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
            let (_pairing, sas) = pair(&mut conn, &b, &b_bundle, &a_bundle, false)
                .await
                .unwrap();
            sas
        })
    };

    let mut conn = tcp::dial(addr).await.unwrap();
    let (_pairing, client_sas) = pair(&mut conn, &a, &a_bundle, &b_bundle, true)
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
        recv_secure_transfer(&mut conn, &b_secret, &a_pub, &dst_path)
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
    let b_bundle = b.pairing_bundle();
    let a_id = a.identity().device_id();

    // UI on B has scanned A's QR bundle and offers it to the engine.
    b.offer_pairing(a.pairing_bundle()).await.unwrap();

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
    a.send_secure(
        b_bundle.identity.device_id,
        b_addr,
        manifest,
        vec![Some(path)],
    )
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
