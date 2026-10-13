// The one-shot pairing code must survive a connection that is not the joiner.
// A stray LAN connection used to take the code before it identified the peer,
// so the real joiner was refused with no visible cause.
//
// Binds sockets, so it needs an unsandboxed run.

use daak_core::control::Hello;
use daak_core::crypto::identity::{import_from_store, Identity};
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::engine::{CodePairingState, Engine, EngineConfig};
use daak_core::framing::RecordType;
use daak_core::net::{tcp, CONTROL_STREAM};
use daak_core::store::Db;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

async fn engine(name: &str, out: PathBuf) -> Arc<Engine> {
    let store = Arc::new(MemorySecretStore::default());
    let identity = import_from_store(store.as_ref()).unwrap();
    let db = Arc::new(Db::open_in_memory().unwrap());
    db.migrate().unwrap();
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

#[tokio::test]
async fn a_stray_connection_does_not_burn_the_pairing_code() {
    let (d1, d2) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let joiner = engine("joiner", d1.path().to_path_buf()).await;
    let host = engine("host", d2.path().to_path_buf()).await;

    host.offer_code_pairing("correct horse battery".into())
        .await
        .unwrap();

    // A stray connection: a valid Hello from an unknown device, then a hang-up.
    {
        let mut stray = tcp::dial(host.local_addr()).await.unwrap();
        let hello = Hello::transfer([0xEE; 16]);
        stray
            .send(
                CONTROL_STREAM,
                RecordType::Control,
                hello.to_cbor().unwrap().into(),
            )
            .await
            .unwrap();
    }
    tokio::time::sleep(Duration::from_millis(300)).await;

    let accept = tokio::spawn({
        let host = host.clone();
        async move { host.accept_pairing_once().await }
    });
    let joined = tokio::time::timeout(
        Duration::from_secs(20),
        joiner.pair_with_code(host.local_addr(), "correct horse battery"),
    )
    .await
    .expect("the joiner must not hang");
    joined.expect("the real joiner must still pair with the code");
    accept.await.unwrap().unwrap();
}

// A connection whose in-band identity does not verify its static binding must
// fail BEFORE the reserve, so it charges no try.
#[tokio::test]
async fn a_mismatched_identity_binding_does_not_charge_a_try() {
    let (d1, d2) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let _joiner = engine("joiner", d1.path().to_path_buf()).await;
    let host = engine("host", d2.path().to_path_buf()).await;

    host.offer_code_pairing("123456".into()).await.unwrap();

    // A Hello and an identity whose device id MATCHES the Hello, but whose
    // static signature is broken. The binding check fails, not the mismatch
    // check.
    {
        let fake = Identity::generate().unwrap();
        let mut public = fake.public();
        public.static_sig[0] ^= 0xFF;
        let mut stray = tcp::dial(host.local_addr()).await.unwrap();
        stray
            .send(
                CONTROL_STREAM,
                RecordType::Control,
                Hello::transfer(public.device_id).to_cbor().unwrap().into(),
            )
            .await
            .unwrap();
        stray
            .send(
                CONTROL_STREAM,
                RecordType::Control,
                public.to_cbor().unwrap().into(),
            )
            .await
            .unwrap();
    }
    tokio::time::sleep(Duration::from_millis(300)).await;

    let status = host.code_pairing_status().await;
    assert_eq!(
        status.state,
        CodePairingState::Armed,
        "the code must stay armed"
    );
    assert_eq!(
        status.tries_left, 3,
        "a failed binding must not charge a try"
    );
}
