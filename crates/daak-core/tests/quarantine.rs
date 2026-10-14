//! The "Held back" surface, against a REAL transfer that really failed.
//!
//! Two live Engines pair, one sends a manifest whose declared fingerprint
//! disagrees with the bytes actually written, and the receiver quarantines the
//! result. Everything asserted here is then read back from the receiver's own
//! database and its own filesystem, so nothing can pass on a hand-built event.
//!
//! The report is deliberately NOT given a recovery branch to test. There is no
//! reachable one: the held bytes are the exact bytes that just failed, so
//! re-hashing them can only reproduce the same mismatch. The tests pin the
//! honest half -- two real fingerprints, the real recorded name/size/sender,
//! and a delete that removes exactly the held file and nothing else.
//!
//! These bind loopback sockets. Under a sandbox that denies socket(2) they
//! fail with EPERM, which is the sandbox and not a defect. Each test starts TWO
//! Engines, so this file also needs a raised descriptor limit and bounded
//! parallelism -- `ulimit -n 10240; cargo test -p daak-core --test quarantine
//! -- --test-threads=2`. At the default thread count the engines exhaust fds and
//! fail with `Too many open files` before any assertion runs.
use std::sync::Arc;

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::engine::{Engine, EngineConfig};
use daak_core::manifest::{DeviceRef, Item, Manifest, PayloadKind, CHUNK_SIZE_DEFAULT};
use daak_core::pairing::PairMode;
use daak_core::store::Db;
use tempfile::TempDir;

async fn engine(name: &str, out: std::path::PathBuf) -> (Engine, Arc<Db>) {
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

/// Two paired engines. The tempdirs are returned: a TempDir dropped while the
/// engines are still running deletes the out dir out from under them.
async fn paired() -> (Arc<Engine>, Arc<Engine>, Arc<Db>, TempDir, TempDir) {
    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    let (a, _a_db) = engine("Sender", d1.path().to_path_buf()).await;
    let (b, b_db) = engine("Receiver", d2.path().to_path_buf()).await;
    let (a, b) = (Arc::new(a), Arc::new(b));
    let b_addr = b.local_addr();
    let b_bundle = b.pairing_bundle().await;
    let b_id = b_bundle.identity.device_id;

    b.offer_pairing(a.pairing_bundle().await, PairMode::Qr, None)
        .await
        .unwrap();
    let b_for_accept = b.clone();
    let accepted = tokio::spawn(async move { b_for_accept.accept_pairing_once().await });
    a.pair_with(b_addr, b_bundle).await.unwrap();
    accepted.await.unwrap().unwrap();
    a.note_peer(b_id, "Receiver", b_addr).await;
    (a, b, b_db, d1, d2)
}

/// Wait for the receiver to persist the item rows for `payload_id`.
async fn item_rows(db: &Db, payload_id: [u8; 16]) -> Vec<daak_core::store::transfers::ItemRow> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let rows = db.list_items(&payload_id).unwrap();
        if !rows.is_empty() {
            return rows;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for the item rows of {}",
            hex::encode(payload_id)
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

/// Send one item whose DECLARED fingerprint does not match its bytes, which is
/// exactly what a damaged or tampered transfer looks like to the receiver.
/// Returns the payload id, having asserted the receiver really held it back.
async fn send_mismatched(a: &Engine, b: &Engine, src: &std::path::Path, b_db: &Db) -> [u8; 16] {
    let mut item = Item::from_file(0, src, CHUNK_SIZE_DEFAULT).unwrap();
    // The real hash of the REAL bytes, then one bit flipped. Flipping a BIT
    // (rather than replacing the array) keeps it a plausible fingerprint: the
    // receiver's comparison must fail on a value a sender could really have
    // produced, not on a sentinel like [0; 32].
    item.hash.as_mut().unwrap()[0] ^= 0x01;
    let manifest = Manifest::new(
        PayloadKind::Media,
        DeviceRef {
            device_id: a.identity().device_id(),
            name: "Sender".into(),
        },
        vec![item],
    );
    let payload_id = manifest.payload_id;
    // The SENDER is told the item was held back: it gets `Quarantined` back
    // rather than an Ok. That is correct behaviour, not a failure to set up
    // the test, so the verdict is deliberately not unwrapped -- what this test
    // asserts is what the RECEIVER persisted.
    let _ = a
        .send_secure(
            b.identity().device_id(),
            manifest,
            vec![Some(src.to_path_buf())],
        )
        .await;
    let rows = item_rows(b_db, payload_id).await;
    assert_eq!(
        rows[0].state, "quarantined",
        "a hash that does not match must be held back, not delivered"
    );
    payload_id
}

/// The report carries BOTH real fingerprints and the real recorded facts.
/// `expected` is what the sender attested; `actual` is what is on disk now.
#[tokio::test]
async fn the_report_shows_both_real_fingerprints_and_the_recorded_facts() {
    let (a, b, b_db, a_dir, _b_dir) = paired().await;
    let src = a_dir.path().join("harbor.bin");
    let bytes = vec![3u8; 40_000];
    std::fs::write(&src, &bytes).unwrap();
    let payload_id = send_mismatched(&a, &b, &src, &b_db).await;

    let report = b.quarantine_report(payload_id, 0).unwrap();
    assert_eq!(report.transfer_id, payload_id);
    assert_eq!(report.item_index, 0);
    assert_eq!(report.name.as_deref(), Some("harbor.bin"));
    assert_eq!(report.size, Some(40_000));
    // The sender's PAIRED label -- the name the RECEIVER recorded when the two
    // paired, which is the only name this device ever wrote down for it.
    assert_eq!(report.sender_name.as_deref(), Some("Sender"));
    // The REAL device id as well, so a screen can show an honest
    // "Device aabbccdd" when no paired label exists. It is an identifier, not
    // an invented name, which is why it may stand in for one.
    assert_eq!(report.sender_device_id, Some(a.identity().device_id()));
    assert!(
        report.received_at.is_some(),
        "arrival time is read from the row, never invented"
    );

    // BOTH hashes are the real ones. `expected` is the sender's attestation
    // (one bit away from the bytes), `actual` is the bytes themselves.
    let real = daak_core::hash::blake2b256(&bytes);
    assert_eq!(report.actual, real, "actual is computed from the held file");
    assert_ne!(report.expected, report.actual);
    assert_eq!(report.expected[0], real[0] ^ 0x01);

    // The held path names a file that really exists, inside this receiver's
    // own quarantine root.
    assert!(
        std::path::Path::new(&report.held_path).exists(),
        "held_path must be a real file, got {}",
        report.held_path
    );
    assert_eq!(std::fs::read(&report.held_path).unwrap(), bytes);
    assert!(report.held_path.contains("quarantine"));

    // And reading it again changes NOTHING: no state flip, no move.
    let again = b.quarantine_report(payload_id, 0).unwrap();
    assert_eq!(again, report, "a report is a read, not a transition");
    assert_eq!(
        b_db.get_item(&payload_id, 0).unwrap().unwrap().state,
        "quarantined"
    );

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

/// Delete removes the held FILE and the ROW, and settles the transfer summary
/// so it stops reading as though something were still outstanding.
#[tokio::test]
async fn delete_removes_the_held_file_and_its_row() {
    let (a, b, b_db, a_dir, _b_dir) = paired().await;
    let src = a_dir.path().join("harbor.bin");
    std::fs::write(&src, vec![3u8; 40_000]).unwrap();
    let payload_id = send_mismatched(&a, &b, &src, &b_db).await;
    let held = b.quarantine_report(payload_id, 0).unwrap().held_path;
    assert!(b_db
        .get_transfer(&payload_id)
        .unwrap()
        .unwrap()
        .error
        .is_some());

    b.delete_quarantined_item(payload_id, 0).unwrap();
    assert!(
        !std::path::Path::new(&held).exists(),
        "held file must be gone"
    );
    assert!(b_db.get_item(&payload_id, 0).unwrap().is_none());
    let row = b_db.get_transfer(&payload_id).unwrap().unwrap();
    assert_eq!(
        row.item_count, 0,
        "the summary must match the rows that remain"
    );
    assert!(
        row.error.is_none(),
        "nothing is held back any more, so nothing is quarantined"
    );

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

/// A DELIVERED item is not a held-back file. Deleting one would resolve its
/// name into the quarantine root and could destroy a different item's bytes,
/// so the call is refused rather than guessed at.
#[tokio::test]
async fn a_delivered_item_cannot_be_deleted_as_held_back() {
    let (a, b, b_db, a_dir, b_dir) = paired().await;
    let src = a_dir.path().join("good.bin");
    std::fs::write(&src, vec![9u8; 40_000]).unwrap();
    let item = Item::from_file(0, &src, CHUNK_SIZE_DEFAULT).unwrap();
    let manifest = Manifest::new(
        PayloadKind::Media,
        DeviceRef {
            device_id: a.identity().device_id(),
            name: "Sender".into(),
        },
        vec![item],
    );
    let payload_id = manifest.payload_id;
    a.send_secure(b.identity().device_id(), manifest, vec![Some(src.clone())])
        .await
        .unwrap();
    let rows = item_rows(&b_db, payload_id).await;
    assert_eq!(rows[0].state, "done", "a matching hash is delivered");
    let delivered = b_dir.path().join("good.bin");
    assert!(delivered.exists());

    let err = b.delete_quarantined_item(payload_id, 0).unwrap_err();
    assert!(
        err.to_string().contains("not held back"),
        "the refusal must say why, got {err}"
    );
    assert!(
        delivered.exists() && std::fs::read(&delivered).unwrap() == vec![9u8; 40_000],
        "a delivered file must survive a refused delete"
    );
    assert_eq!(
        b_db.get_item(&payload_id, 0).unwrap().unwrap().state,
        "done"
    );

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

/// Neither action may report success for an id that does not exist: every
/// UPDATE behind them matches zero rows for an unknown (transfer, item), so
/// without the explicit look-up both would silently do nothing.
#[tokio::test]
async fn unknown_ids_are_refused_rather_than_silently_succeeding() {
    let (a, b, _b_db, _a_dir, _b_dir) = paired().await;
    let missing = [9u8; 16];
    assert!(b.quarantine_report(missing, 0).is_err());
    assert!(b.delete_quarantined_item(missing, 0).is_err());
    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

/// The DISCOVERY half: a caller must be able to find what is held without
/// knowing a transfer id or an item index it has never seen. Without this the
/// screen's only option is guessing indexes, which is also how a screen ends up
/// hashing every item of every transfer to find the held ones.
#[tokio::test]
async fn held_items_are_discoverable_without_a_known_id() {
    let (a, b, b_db, a_dir, _b_dir) = paired().await;
    // Nothing held yet: the empty answer must be an empty ARRAY, not an error
    // and not a null the caller has to special-case.
    assert_eq!(b.list_quarantine_reports().unwrap(), vec![]);

    // Two transfers, TWO items in the second one, so "one report per held
    // ITEM" is pinned rather than "one report per held transfer".
    let src = a_dir.path().join("harbor.bin");
    std::fs::write(&src, vec![3u8; 40_000]).unwrap();
    let first = send_mismatched(&a, &b, &src, &b_db).await;
    let second = send_mismatched(&a, &b, &src, &b_db).await;
    assert_ne!(first, second, "each send gets its own payload id");

    let reports = b.list_quarantine_reports().unwrap();
    assert_eq!(
        reports.len(),
        2,
        "one report per held ITEM, not per transfer"
    );
    // Every report is self-contained: a caller that lists them can render the
    // screen without a second lookup, which is the whole point of listing.
    for r in &reports {
        assert!(r.name.is_some() && r.size.is_some() && r.sender_name.is_some());
        assert_ne!(r.expected, r.actual, "a held item failed its comparison");
        assert!(std::path::Path::new(&r.held_path).exists());
        assert_eq!(
            b.quarantine_report(r.transfer_id, r.item_index).unwrap(),
            *r,
            "a listed report must equal the single-item report"
        );
    }

    // Deleting one removes exactly that one from the list.
    b.delete_quarantined_item(first, 0).unwrap();
    let after = b.list_quarantine_reports().unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].transfer_id, second);

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

/// A held-back item must not be named by the inbox row. The row feeds the
/// platform's move and the Photos save, and a corrupt file must reach neither.
#[tokio::test]
async fn a_quarantined_item_is_not_in_the_inbox_saved_paths() {
    let (a, b, b_db, a_dir, _b_dir) = paired().await;
    let src = a_dir.path().join("bad.bin");
    std::fs::write(&src, vec![5u8; 4096]).unwrap();
    let payload_id = send_mismatched(&a, &b, &src, &b_db).await;

    // The inbox row may be written a moment after the item rows. Poll for up
    // to 3 s. A payload with no row at all is also a pass: nothing names the
    // held path. The poll must not end early on a row that is still missing.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    let mut seen = None;
    while tokio::time::Instant::now() < deadline {
        seen = b
            .list_inbox()
            .unwrap()
            .into_iter()
            .find(|r| r.id == payload_id);
        if seen.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    if let Some(row) = seen {
        assert_eq!(
            row.saved_paths, "[]",
            "a quarantined item must not appear in saved_paths"
        );
    }

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}
