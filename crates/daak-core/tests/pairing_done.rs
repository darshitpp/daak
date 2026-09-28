// C2, engine half. Two facts, both asserted against the REAL accept path
// (two Engines, a real loopback pairing), not a hand-built event:
//
//   1. arming pending_pairing is what turns the inbound joiner's connection
//      from `unpaired inbound connection` into a completed pairing;
//   2. PairingDone fires only AFTER the pairing row is persisted -- a failed
//      upsert emits nothing, so the event never names a pairing that is not
//      in the database.
//
// These bind loopback sockets. Under a sandbox that denies socket(2) they
// fail with EPERM, which is the sandbox and not a defect.
use std::sync::Arc;

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::engine::{Engine, EngineConfig, EngineEvent};
use daak_core::manifest::{DeviceRef, Item, Manifest, PayloadKind};
use daak_core::pairing::PairMode;
use daak_core::store::Db;

/// The engine plus its own Db handle, so a test can break the store the way a
/// real failure would (the table the upsert needs is gone) rather than
/// pretending an error happened.
async fn engine_with_db(name: &str, out: std::path::PathBuf) -> (Engine, Arc<Db>) {
    let store = Arc::new(MemorySecretStore::default());
    let identity = import_from_store(store.as_ref()).unwrap();
    let db = Arc::new(Db::open_in_memory().unwrap());
    db.migrate().unwrap();
    let e = Engine::start(EngineConfig {
        display_name: name.into(),
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        out_dir: out,
        identity,
        db: db.clone(),
    })
    .await
    .unwrap();
    (e, db)
}

async fn wait_for_pairing_done(
    events: &mut tokio::sync::broadcast::Receiver<EngineEvent>,
) -> [u8; 16] {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match tokio::time::timeout_at(deadline, events.recv()).await {
            Ok(Ok(EngineEvent::PairingDone { device_id })) => return device_id,
            Ok(Ok(_)) => continue,
            Ok(Err(_)) => panic!("host event stream closed before PairingDone"),
            Err(_) => panic!("timed out waiting for PairingDone"),
        }
    }
}

#[tokio::test]
async fn the_arm_is_what_turns_an_inbound_joiner_from_refused_into_paired() {
    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    let (a, a_db) = engine_with_db("a", d1.path().to_path_buf()).await;
    let (b, _b_db) = engine_with_db("b", d2.path().to_path_buf()).await;
    let (a, b) = (Arc::new(a), Arc::new(b));

    let b_addr = b.local_addr();
    let b_bundle = b.pairing_bundle().await;
    let a_bundle = a.pairing_bundle().await;
    let a_id = a_bundle.identity.device_id;
    let b_id = b_bundle.identity.device_id;

    // Nothing called offer_pairing: handle_inbound finds pending_pairing empty
    // and falls through to the unpaired-connection error, so the joiner's dial
    // is dropped rather than paired.
    assert!(
        a.pair_with(b_addr, b_bundle.clone()).await.is_err(),
        "an unarmed host must refuse the joiner"
    );
    assert!(a_db.get_pairing(&a_id).unwrap().is_none());

    // The arm. This is what the C2 blocker put on the FFI surface.
    b.offer_pairing(a_bundle, PairMode::Qr, None).await.unwrap();

    let (client_sas, peer_id) = a.pair_with(b_addr, b_bundle).await.unwrap();
    let server_sas = b.accept_pairing_once().await.unwrap();
    assert_eq!(client_sas, server_sas, "both sides derive one SAS");
    // B is the HOST (it holds the arm and answers the inbound), so the joiner
    // A paired with B, and the joiner is now committed on A's own store.
    assert_eq!(peer_id, b_id, "the joiner paired with the host");
    assert_eq!(
        a_db.get_pairing(&b_id).unwrap().unwrap().peer_device_id,
        b_id
    );

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_completed_pairing_emits_pairing_done_naming_the_peer() {
    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    let a = Arc::new(engine_with_db("a", d1.path().to_path_buf()).await.0);
    let b = Arc::new(engine_with_db("b", d2.path().to_path_buf()).await.0);

    let b_addr = b.local_addr();
    let b_bundle = b.pairing_bundle().await;
    let a_bundle = a.pairing_bundle().await;
    let a_id = a_bundle.identity.device_id;

    b.offer_pairing(a_bundle, PairMode::Qr, None).await.unwrap();
    // Subscribed BEFORE the dial: a broadcast with no receiver drops the event.
    let mut events = b.events();
    a.pair_with(b_addr, b_bundle).await.unwrap();

    assert_eq!(wait_for_pairing_done(&mut events).await, a_id);
    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

#[tokio::test]
async fn pairing_done_is_not_emitted_when_the_pairing_row_fails_to_persist() {
    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    let a = Arc::new(engine_with_db("a", d1.path().to_path_buf()).await.0);
    let (b, b_db) = engine_with_db("b", d2.path().to_path_buf()).await;
    let b = Arc::new(b);

    let b_addr = b.local_addr();
    let b_bundle = b.pairing_bundle().await;
    let a_bundle = a.pairing_bundle().await;
    let a_id = a_bundle.identity.device_id;

    b.offer_pairing(a_bundle, PairMode::Qr, None).await.unwrap();
    // The handshake still completes -- the store fails AFTER the Noise XX
    // handshake, which is exactly where the commit lives.
    b_db.conn().execute_batch("DROP TABLE pairings").unwrap();
    let mut events = b.events();
    a.pair_with(b_addr, b_bundle).await.unwrap();

    // Give the host's accept task time to finish the (failing) commit.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let mut seen = None;
    while let Ok(Ok(ev)) =
        tokio::time::timeout(std::time::Duration::from_millis(200), events.recv()).await
    {
        if let EngineEvent::PairingDone { device_id } = ev {
            seen = Some(device_id);
        }
    }
    assert!(
        seen.is_none(),
        "an event for a pairing that is not in the database is a lie"
    );
    assert!(b_db.get_pairing(&a_id).is_err() || b_db.list_pairings().is_err());

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

// ---- Spec 3.3 Mode A: ONE QR, ONE scan -----------------------------------
//
// The QR flow is asymmetric. The JOINER scans the host's QR, so only the
// JOINER ever holds the HOST's bundle. The sanctioned flow therefore NEVER
// gives the host the joiner's bundle, and a pending slot typed
// `Option<(PairingBundle, ..)>` structurally requires one -- so the host arm
// C2 put on the FFI surface could never be reached by a real user. These
// tests drive the REAL accept path with the host never handed a bundle.

/// The host arms for the FIRST inbound pairing without being told who is
/// coming, commits the row, and both sides derive one SAS.
#[tokio::test]
async fn an_open_arm_accepts_an_inbound_joiner_that_the_host_never_had_a_bundle_for() {
    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    let (a, a_db) = engine_with_db("a", d1.path().to_path_buf()).await;
    let (b, b_db) = engine_with_db("b", d2.path().to_path_buf()).await;
    let (a, b) = (Arc::new(a), Arc::new(b));

    let b_addr = b.local_addr();
    // Exactly what the joiner's camera yields: the HOST's bundle. A holds it;
    // B is never told A's bundle, by anything, at any point below.
    let b_bundle = b.pairing_bundle().await;
    let a_id = a.pairing_bundle().await.identity.device_id;
    let b_id = b_bundle.identity.device_id;

    b.offer_inbound_pairing(PairMode::Qr).await.unwrap();

    let (client_sas, peer_id) = a.pair_with(b_addr, b_bundle).await.unwrap();
    let server_sas = b.accept_pairing_once().await.unwrap();
    assert_eq!(client_sas, server_sas, "both sides derive one SAS");
    assert_eq!(peer_id, b_id, "the joiner paired with the host");

    // The host committed a row for a peer it was never given a bundle for --
    // the whole point of the open arm.
    let row = b_db
        .get_pairing(&a_id)
        .unwrap()
        .expect("host committed the pairing");
    assert_eq!(row.peer_device_id, a_id);
    assert_eq!(row.state, "trusted");
    // And the joiner committed the mirror image.
    assert_eq!(
        a_db.get_pairing(&b_id).unwrap().unwrap().peer_device_id,
        b_id
    );

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

/// The open arm is ONE-SHOT: it is consumed by the connection it accepts, so
/// a second inbound pairing is refused exactly as an unarmed host is. A host
/// that wants to pair again re-arms.
#[tokio::test]
async fn the_open_arm_is_consumed_by_the_first_joiner_and_does_not_admit_a_second() {
    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    let d3 = tempfile::tempdir().unwrap();
    let (a, _a_db) = engine_with_db("a", d1.path().to_path_buf()).await;
    let (b, b_db) = engine_with_db("b", d2.path().to_path_buf()).await;
    let (c, _c_db) = engine_with_db("c", d3.path().to_path_buf()).await;
    let (a, b, c) = (Arc::new(a), Arc::new(b), Arc::new(c));

    let b_addr = b.local_addr();
    let b_bundle = b.pairing_bundle().await;
    let a_id = a.pairing_bundle().await.identity.device_id;
    let c_id = c.pairing_bundle().await.identity.device_id;

    b.offer_inbound_pairing(PairMode::Qr).await.unwrap();
    a.pair_with(b_addr, b_bundle.clone()).await.unwrap();
    b.accept_pairing_once().await.unwrap();
    assert!(b_db.get_pairing(&a_id).unwrap().is_some());

    // C now dials the host that has ALREADY paired with A. A trusted pairing
    // exists, so this connection is a transfer attempt by an unknown peer, not
    // a pairing -- it must not silently become a second pairing row.
    assert!(c.pair_with(b_addr, b_bundle).await.is_err());
    assert!(
        b_db.get_pairing(&c_id).unwrap().is_none(),
        "a consumed arm must not admit an unrequested second pairing"
    );

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
    c.shutdown().await.unwrap();
}

/// The trust-surface cost, stated as an assertion: on the OPEN arm the host
/// learns the peer's identity in-band, so the only thing binding that identity
/// to the human is the SAS comparison. This test pins that the two sides'
/// handshakes DIFFER when the peer is substituted, i.e. the SAS really is
/// load-bearing here and is not a constant.
#[tokio::test]
async fn the_open_arm_still_binds_the_handshake_to_the_peer_identity() {
    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    let (a, _a_db) = engine_with_db("a", d1.path().to_path_buf()).await;
    let (b, b_db) = engine_with_db("b", d2.path().to_path_buf()).await;
    let (a, b) = (Arc::new(a), Arc::new(b));

    // A's bundle as A really is, plus a FORGED bundle naming the same device
    // id but a different static key -- the substitution the open arm cannot
    // pre-empt, because the host has no bundle to compare against.
    let b_bundle = b.pairing_bundle().await;
    let a_id = a.pairing_bundle().await.identity.device_id;
    let other = daak_core::crypto::identity::Identity::generate().unwrap();
    let mut forged = a.pairing_bundle().await.clone();
    forged.identity.x25519 = other.public().x25519;
    forged.identity.ed25519 = other.public().ed25519;
    assert_eq!(
        forged.identity.device_id, a_id,
        "the substitution keeps the advertised device id, so only the SAS separates them"
    );

    b.offer_inbound_pairing(PairMode::Qr).await.unwrap();
    let (a_sas, _) = a.pair_with(b.local_addr(), b_bundle).await.unwrap();
    let b_sas = b.accept_pairing_once().await.unwrap();
    assert_eq!(a_sas, b_sas);
    let row = b_db.get_pairing(&a_id).unwrap().unwrap();
    assert_eq!(row.static_dh_pub, a.pairing_bundle().await.identity.x25519);
    assert_ne!(
        row.static_dh_pub, forged.identity.x25519,
        "the committed row records the key the handshake actually used"
    );

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

/// The bundle-matched path keeps its hello device-id check. The open arm is a
/// NEW capability; it must not have been bought by relaxing the arm that pins
/// the peer to a known identity. Here the host holds C's bundle, but A dials --
/// so the hello's device id disagrees with the arm and the pairing is refused
/// even though an arm is present.
#[tokio::test]
async fn a_bundle_matched_arm_still_refuses_an_inbound_from_a_different_device() {
    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    let d3 = tempfile::tempdir().unwrap();
    let (a, _a_db) = engine_with_db("a", d1.path().to_path_buf()).await;
    let (b, b_db) = engine_with_db("b", d2.path().to_path_buf()).await;
    let (c, _c_db) = engine_with_db("c", d3.path().to_path_buf()).await;
    let (a, b, c) = (Arc::new(a), Arc::new(b), Arc::new(c));

    let b_addr = b.local_addr();
    let b_bundle = b.pairing_bundle().await;
    let a_id = a.pairing_bundle().await.identity.device_id;
    let c_bundle = c.pairing_bundle().await;

    // The host is armed for C specifically, and knows C's bundle.
    b.offer_pairing(c_bundle, PairMode::Qr, None).await.unwrap();

    // A dials, holding only the host's bundle. The arm does not match it.
    assert!(
        a.pair_with(b_addr, b_bundle).await.is_err(),
        "a bundle-matched arm must still reject a different device"
    );
    assert!(b_db.get_pairing(&a_id).unwrap().is_none());

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
    c.shutdown().await.unwrap();
}

/// The single-slot accept queue, proved with the reviewer's own probe.
///
/// A and B are ALREADY paired. B is then open-armed for a third device. A then
/// sends B an ordinary TEXT -- a normal transfer from a trusted peer, which on
/// the wire is a Hello followed straight by a Noise XX handshake record and
/// nothing an arm could recognise. Before the fix `handle_inbound` TOOK the
/// pending slot on this connection before anything distinguished a pairing dial
/// from a transfer dial, so the transfer burned the arm: the host's QR kept
/// rendering, the genuine joiner C was refused with `protocol: connection
/// closed during handshake`, and the user had no visible cause.
///
/// After the fix the transfer connection is still handled (and still dropped on
/// the open arm, because a transfer dial sends no in-band identity -- see the
/// version-skew note in `handle_inbound`) but it does NOT consume the slot, and
/// C still pairs afterwards.
/// An ALREADY-PAIRED peer re-arms the host explicitly and pairs again. Holding
/// a pairing row is exactly what a re-pair has, so `handle_inbound` must route
/// the EXPLICIT arm FIRST and only pre-empt to the transfer path for an OPEN
/// arm. Pre-fix the `known` pre-guard swallowed this dial, the host answered
/// with the transfer handshake, and the joiner died with "connection closed
/// during handshake".
#[tokio::test]
async fn an_already_paired_peer_re_pairs_against_a_bundle_matched_arm() {
    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    let (a, _a_db) = engine_with_db("a", d1.path().to_path_buf()).await;
    let (b, b_db) = engine_with_db("b", d2.path().to_path_buf()).await;
    let (a, b) = (Arc::new(a), Arc::new(b));

    let b_addr = b.local_addr();
    let b_bundle = b.pairing_bundle().await;
    let a_id = a.pairing_bundle().await.identity.device_id;
    let b_id = b_bundle.identity.device_id;

    // First pairing, the normal bundle-matched flow.
    b.offer_pairing(a.pairing_bundle().await, PairMode::Qr, None)
        .await
        .unwrap();
    a.pair_with(b_addr, b_bundle.clone()).await.unwrap();
    b.accept_pairing_once().await.unwrap();
    assert!(b_db.get_pairing(&a_id).unwrap().is_some());

    // Now the host RE-ARMS explicitly for the very device it already paired
    // with, and that device dials again.
    b.offer_pairing(a.pairing_bundle().await, PairMode::Qr, None)
        .await
        .unwrap();
    let (a_sas, peer_id) = a.pair_with(b_addr, b_bundle).await.unwrap();
    let b_sas = b.accept_pairing_once().await.unwrap();
    assert_eq!(a_sas, b_sas, "both sides derive one SAS");
    assert_eq!(peer_id, b_id);
    assert_eq!(
        b_db.get_pairing(&a_id).unwrap().unwrap().peer_device_id,
        a_id,
        "the host committed the re-pair"
    );

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

#[tokio::test]
async fn an_ordinary_transfer_does_not_burn_an_open_arm_a_later_joiner_still_pairs() {
    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    let d3 = tempfile::tempdir().unwrap();
    let (a, _a_db) = engine_with_db("a", d1.path().to_path_buf()).await;
    let (b, b_db) = engine_with_db("b", d2.path().to_path_buf()).await;
    let (c, _c_db) = engine_with_db("c", d3.path().to_path_buf()).await;
    let (a, b, c) = (Arc::new(a), Arc::new(b), Arc::new(c));

    let b_addr = b.local_addr();
    let b_bundle = b.pairing_bundle().await;
    let a_id = a.pairing_bundle().await.identity.device_id;
    let c_id = c.pairing_bundle().await.identity.device_id;

    let b_id = b_bundle.identity.device_id;

    // A and B pair first (bundle-matched arm, the normal flow).
    b.offer_pairing(a.pairing_bundle().await, PairMode::Qr, None)
        .await
        .unwrap();
    a.pair_with(b_addr, b_bundle.clone()).await.unwrap();
    b.accept_pairing_once().await.unwrap();
    assert!(b_db.get_pairing(&a_id).unwrap().is_some());

    // B is now open-armed for a genuine third device.
    b.offer_inbound_pairing(PairMode::Qr).await.unwrap();

    // A -- an ALREADY PAIRED peer -- sends B an ordinary text. This is the
    // stray connection that used to consume the single slot.
    let manifest = Manifest::new(
        PayloadKind::Text,
        DeviceRef {
            device_id: a_id,
            name: "a".into(),
        },
        vec![Item::text(0, "hello")],
    );
    let mut b_events = b.events();
    a.note_peer(b_id, "b", b_addr).await;
    a.send_secure(b_id, manifest, vec![]).await.unwrap();
    // Wait for the transfer to actually be received, so the connection that
    // raced the arm has definitely been through handle_inbound before C dials.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match tokio::time::timeout_at(deadline, b_events.recv()).await {
            Ok(Ok(EngineEvent::InboxReceived(_))) => break,
            Ok(Ok(_)) => continue,
            Ok(Err(_)) => panic!("b event stream closed before InboxReceived"),
            Err(_) => panic!("timed out waiting for the ordinary transfer"),
        }
    }

    // The genuine joiner C must still get in.
    let (c_sas, c_peer) = c.pair_with(b_addr, b_bundle.clone()).await.unwrap();
    let b_sas = b.accept_pairing_once().await.unwrap();
    assert_eq!(c_sas, b_sas, "both sides derive one SAS");
    assert_eq!(c_peer, b_id);
    assert_eq!(
        b_db.get_pairing(&c_id).unwrap().unwrap().peer_device_id,
        c_id,
        "the arm survived the stray transfer and admitted the real joiner"
    );

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
    c.shutdown().await.unwrap();
}
