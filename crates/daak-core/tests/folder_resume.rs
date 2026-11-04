//! Task 2b: resume. A retry sends only the chunks that the receiver lacks.
//!
//! The receiver sends one `ResumeMsg` (a `RecordType::Nack` frame on
//! `CONTROL_STREAM`) after it accepts the manifest. `ranges[i]` names the
//! half-open chunk ranges that item `i` still needs. A present and empty list
//! means "I have the whole item". The sender waits for that frame when the peer
//! announced version 101 or more. It then streams only those chunks.
//!
//! The tests drive the real `send_transfer_resuming` and the real
//! `receive_transfer` over loopback TCP. A `Tap` counts the chunk bytes that
//! the sender puts on the wire for each item.

mod support;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use bytes::Bytes;
use daak_core::control::AckMsg;
use daak_core::framing::RecordType;
use daak_core::manifest::{from_picked_paths, Manifest, CHUNK_SIZE_MIN};
use daak_core::net::{tcp, CONTROL_STREAM};
use daak_core::store::inbox::InboxRow;
use daak_core::store::transfers::{ItemRow, TransferRow};
use daak_core::transfer::{
    decode_chunk_body, receive_transfer, resume_wait, send_transfer, send_transfer_resuming,
    RESUME_WAIT,
};
use support::{
    db, file_bytes, folder, read_resume, resumed_pass, send_chunk, sender_ref, CHUNK, FILE_LEN,
};

#[tokio::test]
async fn a_new_transfer_gets_a_full_resume_message_and_sends_everything() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let (manifest, paths) = folder(src.path());

    // Part 1: look at the frame itself.
    let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let m = manifest.clone();
    let p = paths.clone();
    let peer = tokio::spawn(async move {
        let (mut conn, _) = tcp::accept(&listener).await.unwrap();
        conn.send(
            CONTROL_STREAM,
            RecordType::Manifest,
            Bytes::from(m.to_cbor().unwrap()),
        )
        .await
        .unwrap();
        let resume = read_resume(&mut conn).await;
        assert_eq!(resume.transfer_id, m.payload_id);
        let full: Vec<Vec<(u64, u64)>> = m
            .items
            .iter()
            .map(|i| vec![(0, i.chunk_count.unwrap())])
            .collect();
        assert_eq!(resume.ranges, full, "a new transfer needs every chunk");
        for item in &m.items {
            let bytes = std::fs::read(p[item.index as usize].as_ref().unwrap()).unwrap();
            for c in 0..item.chunk_count.unwrap() {
                send_chunk(&mut conn, item.index, c, &bytes).await;
            }
        }
        loop {
            let f = conn.recv().await.unwrap().unwrap();
            if f.kind == RecordType::Ack {
                assert!(AckMsg::from_cbor(&f.body).unwrap().hash_ok);
                return;
            }
        }
    });
    let mut conn = tcp::dial(addr).await.unwrap();
    let db1 = db();
    receive_transfer(&mut conn, dst.path(), |_| {}, Some(&db1), |_| {})
        .await
        .unwrap();
    peer.await.unwrap();

    // Part 2: the real sender sends every byte of a new transfer.
    let dst2 = tempfile::tempdir().unwrap();
    let db2 = db();
    let (sent, r, _) = resumed_pass(&manifest, &paths, dst2.path(), &db2).await;
    r.unwrap();
    for item in &manifest.items {
        assert_eq!(sent.get(&item.index), Some(&(FILE_LEN as u64)));
    }
    assert_eq!(
        std::fs::read(dst2.path().join("album/b.bin")).unwrap(),
        file_bytes(2)
    );
}

#[tokio::test]
async fn a_dropped_connection_then_retry_sends_only_the_missing_chunks() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let (manifest, paths) = folder(src.path());
    let db = db();

    // Connection 1: files 1 and 3 in full, then chunks 0 and 1 of file 2. Then
    // the connection drops.
    let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let m = manifest.clone();
    let p = paths.clone();
    let dropper = tokio::spawn(async move {
        let (mut conn, _) = tcp::accept(&listener).await.unwrap();
        conn.send(
            CONTROL_STREAM,
            RecordType::Manifest,
            Bytes::from(m.to_cbor().unwrap()),
        )
        .await
        .unwrap();
        let _ = read_resume(&mut conn).await;
        for item in [0u32, 2] {
            let bytes = std::fs::read(p[item as usize].as_ref().unwrap()).unwrap();
            for c in 0..4 {
                send_chunk(&mut conn, item, c, &bytes).await;
            }
        }
        let b = std::fs::read(p[1].as_ref().unwrap()).unwrap();
        send_chunk(&mut conn, 1, 0, &b).await;
        send_chunk(&mut conn, 1, 1, &b).await;
    });
    let mut conn = tcp::dial(addr).await.unwrap();
    let first = tokio::time::timeout(
        Duration::from_secs(10),
        receive_transfer(&mut conn, dst.path(), |_| {}, Some(&db), |_| {}),
    )
    .await
    .expect("pass 1 hung");
    dropper.await.unwrap();
    assert!(
        matches!(first, Err(daak_core::CoreError::TransferInterrupted)),
        "a drop is an interrupt, got {first:?}"
    );

    // Connection 2: the retry.
    let (sent, r, _) = resumed_pass(&manifest, &paths, dst.path(), &db).await;
    r.unwrap();
    assert_eq!(sent.get(&0).copied().unwrap_or(0), 0, "file 1 adds 0 bytes");
    assert_eq!(sent.get(&2).copied().unwrap_or(0), 0, "file 3 adds 0 bytes");
    assert_eq!(
        sent.get(&1).copied().unwrap_or(0),
        (FILE_LEN - 2 * CHUNK) as u64,
        "file 2 adds only its missing chunks"
    );
    for (name, seed) in [("a.bin", 1u8), ("b.bin", 2), ("c.bin", 3)] {
        assert_eq!(
            std::fs::read(dst.path().join("album").join(name)).unwrap(),
            file_bytes(seed),
            "{name} is complete"
        );
    }
}

#[tokio::test]
async fn a_file_that_failed_its_hash_is_sent_again_in_full() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let (manifest, paths) = folder(src.path());
    let db = db();

    // Connection 1: the sender streams a changed b.bin. The hash check fails
    // and the receiver quarantines item 1.
    let bad_dir = tempfile::tempdir().unwrap();
    let bad = bad_dir.path().join("b.bin");
    let mut wrong = file_bytes(2);
    wrong[5] ^= 0xff;
    std::fs::write(&bad, &wrong).unwrap();
    let mut bad_paths = paths.clone();
    bad_paths[1] = Some(bad);
    let (_, r, _) = resumed_pass(&manifest, &bad_paths, dst.path(), &db).await;
    assert!(
        matches!(
            r,
            Err(daak_core::CoreError::Quarantined { item_index: 1, .. })
        ),
        "item 1 is quarantined, got {r:?}"
    );
    // The engine records the inbox row after this receive. Do the same, so
    // the duplicate check sees the payload.
    db.add_inbox_once(&InboxRow {
        id: manifest.payload_id,
        transfer_id: manifest.payload_id,
        peer_device_id: manifest.sender.device_id,
        kind: "batch".into(),
        item_count: 3,
        summary: "3 file(s)".into(),
        received_at: 0,
        saved_paths: "[]".into(),
        group_roots: Vec::new(),
    })
    .unwrap();

    // Connection 2: the retry with the good bytes.
    let (sent, r, _) = resumed_pass(&manifest, &paths, dst.path(), &db).await;
    r.unwrap();
    assert_eq!(sent.get(&0).copied().unwrap_or(0), 0, "file 1 is done");
    assert_eq!(sent.get(&2).copied().unwrap_or(0), 0, "file 3 is done");
    assert_eq!(
        sent.get(&1).copied().unwrap_or(0),
        FILE_LEN as u64,
        "the quarantined file is sent again in full"
    );
    assert_eq!(
        std::fs::read(dst.path().join("album/b.bin")).unwrap(),
        file_bytes(2)
    );
    assert_eq!(
        db.get_item(&manifest.payload_id, 1).unwrap().unwrap().state,
        "done"
    );
}

/// A peer that reads every chunk and never sends a resume message. It acks
/// when it has the last chunk.
async fn silent_peer(listener: tokio::net::TcpListener, m: Manifest) -> u64 {
    let (mut conn, _) = tcp::accept(&listener).await.unwrap();
    let want: u64 = m.items.iter().map(|i| i.chunk_count.unwrap()).sum();
    let mut got = 0u64;
    let mut bytes = 0u64;
    while got < want {
        let f = conn.recv().await.unwrap().unwrap();
        if f.kind == RecordType::Chunk {
            got += 1;
            bytes += decode_chunk_body(&f.body).unwrap().2.len() as u64;
        }
    }
    let ack = AckMsg {
        transfer_id: m.payload_id,
        item_index: 0,
        complete: true,
        hash_ok: true,
    };
    conn.send(
        CONTROL_STREAM,
        RecordType::Ack,
        Bytes::from(ack.to_cbor().unwrap()),
    )
    .await
    .unwrap();
    bytes
}

#[tokio::test]
async fn a_100_receiver_gets_everything_and_the_sender_does_not_wait() {
    assert_eq!(resume_wait(Some(100)), None, "a 100 peer gets no wait");
    assert_eq!(resume_wait(None), None, "an unknown version gets no wait");
    assert_eq!(resume_wait(Some(101)), Some(RESUME_WAIT));
    assert_eq!(RESUME_WAIT, Duration::from_secs(10));

    let src = tempfile::tempdir().unwrap();
    let (manifest, paths) = folder(src.path());
    let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let peer = tokio::spawn(silent_peer(listener, manifest.clone()));
    let mut conn = tcp::dial(addr).await.unwrap();
    let started = Instant::now();
    send_transfer_resuming(&mut conn, &manifest, &paths, resume_wait(Some(100)), |_| {})
        .await
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "the sender must not wait for a 100 peer, took {:?}",
        started.elapsed()
    );
    assert_eq!(peer.await.unwrap(), 3 * FILE_LEN as u64);
}

#[tokio::test]
async fn a_101_receiver_that_never_answers_gets_everything_after_the_timeout() {
    let src = tempfile::tempdir().unwrap();
    let (manifest, paths) = folder(src.path());
    let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let peer = tokio::spawn(silent_peer(listener, manifest.clone()));
    let mut conn = tcp::dial(addr).await.unwrap();
    let wait = Duration::from_millis(300);
    let started = Instant::now();
    send_transfer_resuming(&mut conn, &manifest, &paths, Some(wait), |_| {})
        .await
        .unwrap();
    assert!(started.elapsed() >= wait, "the sender waits first");
    assert_eq!(peer.await.unwrap(), 3 * FILE_LEN as u64);
}

#[tokio::test]
async fn an_old_sender_ignores_the_resume_frame() {
    // `send_transfer` with no ranges is the version 100 sender: it never reads
    // a frame before its ack loop, and the ack loop skips unknown kinds.
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let (manifest, paths) = folder(src.path());
    let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let m = manifest.clone();
    let sender = tokio::spawn(async move {
        let (mut conn, _) = tcp::accept(&listener).await.unwrap();
        send_transfer(&mut conn, &m, &paths, &[], |_| {}).await
    });
    let db = db();
    let mut conn = tcp::dial(addr).await.unwrap();
    tokio::time::timeout(
        Duration::from_secs(10),
        receive_transfer(&mut conn, dst.path(), |_| {}, Some(&db), |_| {}),
    )
    .await
    .expect("the receive hung")
    .unwrap();
    sender.await.unwrap().unwrap();
    assert_eq!(
        std::fs::read(dst.path().join("album/c.bin")).unwrap(),
        file_bytes(3)
    );
}

#[tokio::test]
async fn progress_starts_at_the_bytes_already_held() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let (manifest, paths) = folder(src.path());
    let db = db();

    // Connection 1: file 1 in full, then the connection drops.
    let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let m = manifest.clone();
    let p = paths.clone();
    let dropper = tokio::spawn(async move {
        let (mut conn, _) = tcp::accept(&listener).await.unwrap();
        conn.send(
            CONTROL_STREAM,
            RecordType::Manifest,
            Bytes::from(m.to_cbor().unwrap()),
        )
        .await
        .unwrap();
        let _ = read_resume(&mut conn).await;
        let a = std::fs::read(p[0].as_ref().unwrap()).unwrap();
        for c in 0..4 {
            send_chunk(&mut conn, 0, c, &a).await;
        }
    });
    let mut conn = tcp::dial(addr).await.unwrap();
    let _ = receive_transfer(&mut conn, dst.path(), |_| {}, Some(&db), |_| {}).await;
    dropper.await.unwrap();

    let (_, r, progress) = resumed_pass(&manifest, &paths, dst.path(), &db).await;
    r.unwrap();
    assert_eq!(
        progress.first().copied(),
        Some(FILE_LEN as u64),
        "the first progress value is the bytes the receiver holds"
    );
    assert_eq!(
        progress.iter().sum::<u64>(),
        3 * FILE_LEN as u64,
        "the bar ends at the total"
    );
}

/// Build the manifest of `album` again after a change on disk. The new
/// manifest keeps the payload id of `old`.
fn rebuilt(src: &Path, old: &Manifest) -> (Manifest, Vec<Option<PathBuf>>) {
    let (mut m, sources) =
        from_picked_paths(sender_ref(), &[src.join("album")], CHUNK_SIZE_MIN).unwrap();
    m.payload_id = old.payload_id;
    assert_ne!(
        m.to_cbor().unwrap(),
        old.to_cbor().unwrap(),
        "the test needs a changed manifest"
    );
    (m, sources.into_iter().map(Some).collect())
}

/// The bytes of `b.bin` with 1 changed byte in chunk 0. The length is the same.
fn changed_b() -> Vec<u8> {
    let mut b = file_bytes(2);
    b[5] ^= 0xff;
    b
}

#[tokio::test]
async fn a_resend_with_a_changed_manifest_and_the_same_payload_id_hashes_every_item_against_the_new_manifest(
) {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let (manifest, paths) = folder(src.path());
    let db = db();
    let (_, r, _) = resumed_pass(&manifest, &paths, dst.path(), &db).await;
    r.unwrap();
    for i in 0..3 {
        let row = db.get_item(&manifest.payload_id, i).unwrap().unwrap();
        assert_eq!(row.state, "done", "item {i} is done after pass 1");
    }

    // The sender changes b.bin and sends again under the same payload id.
    std::fs::write(src.path().join("album/b.bin"), changed_b()).unwrap();
    let (changed, new_paths) = rebuilt(src.path(), &manifest);
    let (sent, r, _) = resumed_pass(&changed, &new_paths, dst.path(), &db).await;
    r.unwrap();
    for i in 0..3u32 {
        assert_eq!(
            sent.get(&i).copied().unwrap_or(0),
            FILE_LEN as u64,
            "item {i} crosses the wire in full"
        );
    }
    // The folder `album` exists from pass 1, so the whole group takes the
    // suffix. The first copy stays as it is.
    assert_eq!(
        std::fs::read(dst.path().join("album-1/b.bin")).unwrap(),
        changed_b(),
        "the changed file has the new bytes"
    );
    assert_eq!(
        std::fs::read(dst.path().join("album/b.bin")).unwrap(),
        file_bytes(2),
        "the first copy is not overwritten"
    );
    let row = db.get_transfer(&manifest.payload_id).unwrap().unwrap();
    assert_eq!(row.manifest, changed.to_cbor().unwrap());
}

/// A fresh start after a changed manifest gives each item a new empty file.
/// A shorter new file keeps no tail bytes of the old file. The first copy
/// stays as it is.
#[tokio::test]
async fn a_resend_with_a_shorter_changed_file_keeps_no_old_tail_bytes_and_keeps_the_first_copy() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let (manifest, paths) = folder(src.path());
    let db = db();
    let (_, r, _) = resumed_pass(&manifest, &paths, dst.path(), &db).await;
    r.unwrap();

    let short = file_bytes(9)[..CHUNK + 10].to_vec();
    assert!(short.len() < FILE_LEN);
    std::fs::write(src.path().join("album/b.bin"), &short).unwrap();
    let (changed, new_paths) = rebuilt(src.path(), &manifest);
    let (_, r, _) = resumed_pass(&changed, &new_paths, dst.path(), &db).await;
    r.unwrap();

    let row = db.get_item(&manifest.payload_id, 1).unwrap().unwrap();
    assert_eq!(row.state, "done", "the hash of the short file matches");
    let landed = PathBuf::from(row.dest_path.unwrap());
    assert_eq!(std::fs::read(&landed).unwrap(), short, "no old tail bytes");
    assert_ne!(landed, dst.path().join("album/b.bin"));
    assert_eq!(
        std::fs::read(dst.path().join("album/b.bin")).unwrap(),
        file_bytes(2),
        "the first copy is not overwritten"
    );
}

#[tokio::test]
async fn an_interrupted_receive_with_bitmaps_and_no_rows_starts_fresh_when_the_manifest_changes() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let (manifest, paths) = folder(src.path());
    let db = db();

    // Connection 1: files 1 and 3 in full, then chunks 0 and 1 of file 2. Then
    // the connection drops.
    let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let m = manifest.clone();
    let p = paths.clone();
    let dropper = tokio::spawn(async move {
        let (mut conn, _) = tcp::accept(&listener).await.unwrap();
        conn.send(
            CONTROL_STREAM,
            RecordType::Manifest,
            Bytes::from(m.to_cbor().unwrap()),
        )
        .await
        .unwrap();
        let _ = read_resume(&mut conn).await;
        for item in [0u32, 2] {
            let bytes = std::fs::read(p[item as usize].as_ref().unwrap()).unwrap();
            for c in 0..4 {
                send_chunk(&mut conn, item, c, &bytes).await;
            }
        }
        let b = std::fs::read(p[1].as_ref().unwrap()).unwrap();
        send_chunk(&mut conn, 1, 0, &b).await;
        send_chunk(&mut conn, 1, 1, &b).await;
    });
    let mut conn = tcp::dial(addr).await.unwrap();
    let first = tokio::time::timeout(
        Duration::from_secs(10),
        receive_transfer(&mut conn, dst.path(), |_| {}, Some(&db), |_| {}),
    )
    .await
    .expect("pass 1 hung");
    dropper.await.unwrap();
    assert!(
        matches!(first, Err(daak_core::CoreError::TransferInterrupted)),
        "a drop is an interrupt, got {first:?}"
    );
    assert!(
        db.list_items(&manifest.payload_id).unwrap().is_empty(),
        "an interrupted receive writes no item rows"
    );
    assert!(
        db.load_bitmap(&manifest.payload_id, 1, 4)
            .unwrap()
            .is_set(0),
        "the receiver holds chunk 0 of file 2"
    );

    // Connection 2: a changed b.bin under the same payload id.
    std::fs::write(src.path().join("album/b.bin"), changed_b()).unwrap();
    let (changed, new_paths) = rebuilt(src.path(), &manifest);
    let (sent, r, _) = resumed_pass(&changed, &new_paths, dst.path(), &db).await;
    r.unwrap();
    for i in 0..3u32 {
        assert_eq!(
            sent.get(&i).copied().unwrap_or(0),
            FILE_LEN as u64,
            "item {i} crosses the wire in full"
        );
    }
    // Pass 1 made the folder `album`, so the fresh start takes `album-1`.
    assert_eq!(
        std::fs::read(dst.path().join("album-1/b.bin")).unwrap(),
        changed_b()
    );
}

#[tokio::test]
async fn a_manifest_that_shrinks_leaves_no_old_item_rows() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let (manifest, paths) = folder(src.path());
    let db = db();
    let (_, r, _) = resumed_pass(&manifest, &paths, dst.path(), &db).await;
    r.unwrap();
    assert_eq!(db.list_items(&manifest.payload_id).unwrap().len(), 3);

    // The sender removes c.bin and sends again under the same payload id.
    std::fs::remove_file(src.path().join("album/c.bin")).unwrap();
    let (smaller, new_paths) = rebuilt(src.path(), &manifest);
    assert_eq!(smaller.items.len(), 2);
    let (_, r, _) = resumed_pass(&smaller, &new_paths, dst.path(), &db).await;
    r.unwrap();
    let rows: Vec<u32> = db
        .list_items(&manifest.payload_id)
        .unwrap()
        .iter()
        .map(|r| r.item_index)
        .collect();
    assert_eq!(rows, vec![0, 1], "no row of the old item 2 stays");
    let row = db.get_transfer(&manifest.payload_id).unwrap().unwrap();
    assert_eq!(
        row.item_count as usize,
        rows.len(),
        "the item count follows the new manifest"
    );
}

#[tokio::test]
async fn a_resend_with_the_same_manifest_still_resumes() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let (manifest, paths) = folder(src.path());
    let db = db();
    let (_, r, _) = resumed_pass(&manifest, &paths, dst.path(), &db).await;
    r.unwrap();

    let (sent, r, _) = resumed_pass(&manifest, &paths, dst.path(), &db).await;
    r.unwrap();
    for i in 0..3u32 {
        assert_eq!(
            sent.get(&i).copied().unwrap_or(0),
            0,
            "item {i} does not cross the wire again"
        );
    }
    assert_eq!(db.list_items(&manifest.payload_id).unwrap().len(), 3);
}

#[tokio::test]
async fn a_peer_that_reuses_the_payload_id_of_an_outbound_transfer_leaves_that_transfer_untouched()
{
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let (manifest, paths) = folder(src.path());
    let db = db();
    let id = manifest.payload_id;

    // This device sent a payload with the same id to another peer.
    let out = TransferRow {
        transfer_id: id,
        payload_id: id,
        peer_device_id: [9u8; 16],
        direction: "out".into(),
        kind: "media".into(),
        state: "done".into(),
        bytes_total: 3 * FILE_LEN as u64,
        bytes_done: 3 * FILE_LEN as u64,
        item_count: 3,
        created_at: 1,
        updated_at: 1,
        manifest: vec![1, 2, 3],
        error: None,
    };
    db.upsert_transfer(&out).unwrap();
    for i in 0..3u32 {
        db.upsert_item(&ItemRow {
            transfer_id: id,
            item_index: i,
            item_type: "document".into(),
            name: None,
            mime: None,
            size: Some(FILE_LEN as u64),
            hash: None,
            dest_path: None,
            state: "done".into(),
        })
        .unwrap();
    }
    // A bitmap at an index that the incoming manifest does not name.
    let mut held = daak_core::chunk::ChunkBitmap::new(4);
    held.set(0);
    db.save_bitmap(&id, 7, &held).unwrap();
    let rows_before = db.list_items(&id).unwrap();

    let _ = resumed_pass(&manifest, &paths, dst.path(), &db).await;

    let row = db.get_transfer(&id).unwrap().unwrap();
    assert_eq!(row.direction, "out");
    assert_eq!(row.manifest, out.manifest, "the manifest stays");
    assert_eq!(row.peer_device_id, out.peer_device_id, "the peer stays");
    assert_eq!(row.kind, out.kind, "the kind stays");
    assert_eq!(row.item_count, 3, "the item count stays");
    assert_eq!(db.list_items(&id).unwrap(), rows_before, "the rows stay");
    assert!(
        db.load_bitmap(&id, 7, 4).unwrap().is_set(0),
        "the bitmap stays"
    );
}

/// One interrupted receive: files 1 and 3 in full, then chunks 0 and 1 of
/// file 2. Then the connection drops.
async fn interrupted_pass(
    manifest: &Manifest,
    paths: &[Option<PathBuf>],
    dst: &Path,
    db: &daak_core::store::Db,
) {
    let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let m = manifest.clone();
    let p = paths.to_vec();
    let dropper = tokio::spawn(async move {
        let (mut conn, _) = tcp::accept(&listener).await.unwrap();
        conn.send(
            CONTROL_STREAM,
            RecordType::Manifest,
            Bytes::from(m.to_cbor().unwrap()),
        )
        .await
        .unwrap();
        let _ = read_resume(&mut conn).await;
        for item in [0u32, 2] {
            let bytes = std::fs::read(p[item as usize].as_ref().unwrap()).unwrap();
            for c in 0..4 {
                send_chunk(&mut conn, item, c, &bytes).await;
            }
        }
        let b = std::fs::read(p[1].as_ref().unwrap()).unwrap();
        send_chunk(&mut conn, 1, 0, &b).await;
        send_chunk(&mut conn, 1, 1, &b).await;
    });
    let mut conn = tcp::dial(addr).await.unwrap();
    let first = tokio::time::timeout(
        Duration::from_secs(10),
        receive_transfer(&mut conn, dst, |_| {}, Some(db), |_| {}),
    )
    .await
    .expect("the interrupted pass hung");
    dropper.await.unwrap();
    assert!(
        matches!(first, Err(daak_core::CoreError::TransferInterrupted)),
        "a drop is an interrupt, got {first:?}"
    );
}

fn list_key(manifest: &Manifest) -> String {
    format!("dest:{}", hex::encode(manifest.payload_id))
}

/// Every item row is `done`, and each row path holds the right bytes.
fn assert_all_done(db: &daak_core::store::Db, manifest: &Manifest) {
    for (i, seed) in [(0u32, 1u8), (1, 2), (2, 3)] {
        let row = db.get_item(&manifest.payload_id, i).unwrap().unwrap();
        assert_eq!(row.state, "done", "item {i}");
        assert_eq!(
            std::fs::read(row.dest_path.unwrap()).unwrap(),
            file_bytes(seed),
            "item {i}"
        );
    }
}

/// F4: the first attempt chooses `album-1`, because `album` exists. The
/// resume reuses those paths. A partial file does not take a suffix, and only
/// the missing chunks cross the wire.
#[tokio::test]
async fn a_resume_keeps_the_destinations_chosen_by_the_first_attempt() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    std::fs::create_dir(dst.path().join("album")).unwrap();
    let (manifest, paths) = folder(src.path());
    let db = db();
    interrupted_pass(&manifest, &paths, dst.path(), &db).await;
    assert!(db.get_setting(&list_key(&manifest)).unwrap().is_some());

    let (sent, r, _) = resumed_pass(&manifest, &paths, dst.path(), &db).await;
    r.unwrap();
    assert_eq!(sent.get(&0).copied().unwrap_or(0), 0, "file 1 adds 0 bytes");
    assert_eq!(sent.get(&2).copied().unwrap_or(0), 0, "file 3 adds 0 bytes");
    assert_eq!(
        sent.get(&1).copied().unwrap_or(0),
        (FILE_LEN - 2 * CHUNK) as u64,
        "file 2 adds only its missing chunks"
    );
    for (i, (name, seed)) in [("a.bin", 1u8), ("b.bin", 2), ("c.bin", 3)]
        .iter()
        .enumerate()
    {
        let path = dst.path().join("album-1").join(name);
        assert_eq!(std::fs::read(&path).unwrap(), file_bytes(*seed));
        let row = db
            .get_item(&manifest.payload_id, i as u32)
            .unwrap()
            .unwrap();
        assert_eq!(row.dest_path.as_deref(), path.to_str());
    }
    assert!(!dst.path().join("album-2").exists(), "no second suffix");
    assert!(
        !dst.path().join("album-1/b-1.bin").exists(),
        "no file suffix"
    );
    assert_eq!(
        std::fs::read_dir(dst.path().join("album")).unwrap().count(),
        0
    );
}

/// F4: an older receiver stored bitmaps and no list, or a crash came before
/// the list write. A partial file can then hold bytes that the bitmap does not
/// describe. The payload starts fresh: new files, every chunk, no quarantine.
#[tokio::test]
async fn bitmaps_with_no_stored_list_and_partial_files_give_correct_bytes_and_no_quarantine() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let (manifest, paths) = folder(src.path());
    let db = db();
    interrupted_pass(&manifest, &paths, dst.path(), &db).await;
    db.delete_setting(&list_key(&manifest)).unwrap();
    // The bitmap of file 2 names chunks 0 and 1. The partial file does not
    // hold them.
    assert!(db
        .load_bitmap(&manifest.payload_id, 1, 4)
        .unwrap()
        .is_set(0));
    std::fs::write(dst.path().join("album/b.bin"), vec![0u8; 2 * CHUNK]).unwrap();

    let (sent, r, _) = resumed_pass(&manifest, &paths, dst.path(), &db).await;
    r.unwrap();
    for i in 0..3u32 {
        assert_eq!(
            sent.get(&i).copied().unwrap_or(0),
            FILE_LEN as u64,
            "item {i} crosses the wire in full"
        );
    }
    assert_all_done(&db, &manifest);
    assert!(!dst.path().join("quarantine").exists(), "no quarantine");
}

/// F4: the stored list is a hint. A path that leaves dest_root is ignored,
/// and the payload starts fresh. Nothing is written outside dest_root.
#[tokio::test]
async fn a_stored_path_that_escapes_dest_root_is_ignored_and_the_payload_starts_fresh() {
    for bad in ["../evil/b.bin", "/tmp/b.bin", "album/../../evil/b.bin"] {
        let base = tempfile::tempdir().unwrap();
        let dst = base.path().join("out");
        std::fs::create_dir(&dst).unwrap();
        let src = tempfile::tempdir().unwrap();
        let (manifest, paths) = folder(src.path());
        let db = db();
        interrupted_pass(&manifest, &paths, &dst, &db).await;
        // A file outside dest_root that the bad list names.
        std::fs::create_dir(base.path().join("evil")).unwrap();
        std::fs::write(base.path().join("evil/b.bin"), b"outside").unwrap();
        let list = vec![
            "album/a.bin".to_string(),
            bad.to_string(),
            "album/c.bin".to_string(),
        ];
        let mut bytes = Vec::new();
        ciborium::into_writer(&list, &mut bytes).unwrap();
        db.set_setting(&list_key(&manifest), &bytes).unwrap();

        let (sent, r, _) = resumed_pass(&manifest, &paths, &dst, &db).await;
        r.unwrap();
        for i in 0..3u32 {
            assert_eq!(
                sent.get(&i).copied().unwrap_or(0),
                FILE_LEN as u64,
                "{bad}: item {i} crosses the wire in full"
            );
        }
        assert_all_done(&db, &manifest);
        for i in 0..3u32 {
            let row = db.get_item(&manifest.payload_id, i).unwrap().unwrap();
            assert!(
                Path::new(&row.dest_path.unwrap()).starts_with(&dst),
                "{bad}"
            );
        }
        assert_eq!(
            std::fs::read(base.path().join("evil/b.bin")).unwrap(),
            b"outside",
            "{bad}"
        );
    }
}

/// F4: a listed file of an open item is gone. The payload starts fresh, so
/// no item hashes a file that holds only part of its chunks.
#[tokio::test]
async fn a_listed_file_that_is_gone_starts_the_payload_fresh() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let (manifest, paths) = folder(src.path());
    let db = db();
    interrupted_pass(&manifest, &paths, dst.path(), &db).await;
    std::fs::remove_file(dst.path().join("album/b.bin")).unwrap();

    let (sent, r, _) = resumed_pass(&manifest, &paths, dst.path(), &db).await;
    r.unwrap();
    for i in 0..3u32 {
        assert_eq!(
            sent.get(&i).copied().unwrap_or(0),
            FILE_LEN as u64,
            "item {i} crosses the wire in full"
        );
    }
    assert_all_done(&db, &manifest);
    assert!(!dst.path().join("quarantine").exists(), "no quarantine");
}

/// F4: the list lives only while a receive can resume. A fresh start, a
/// completed receive, and a cancel each delete it. The quarantine test file
/// checks the delete of the last held item.
#[tokio::test]
async fn a_fresh_start_a_completed_receive_a_cancel_and_a_delete_history_each_delete_the_list() {
    let src = tempfile::tempdir().unwrap();
    let (manifest, paths) = folder(src.path());

    // A completed receive.
    let dst = tempfile::tempdir().unwrap();
    let db1 = db();
    interrupted_pass(&manifest, &paths, dst.path(), &db1).await;
    assert!(db1.get_setting(&list_key(&manifest)).unwrap().is_some());
    let (_, r, _) = resumed_pass(&manifest, &paths, dst.path(), &db1).await;
    r.unwrap();
    assert!(
        db1.get_setting(&list_key(&manifest)).unwrap().is_none(),
        "completed"
    );

    // A fresh start.
    let dst = tempfile::tempdir().unwrap();
    let db2 = db();
    interrupted_pass(&manifest, &paths, dst.path(), &db2).await;
    db2.fresh_start(
        &manifest.payload_id,
        &manifest.payload_id,
        &manifest.sender.device_id,
        "batch",
        3,
        &manifest.to_cbor().unwrap(),
    )
    .unwrap();
    assert!(
        db2.get_setting(&list_key(&manifest)).unwrap().is_none(),
        "fresh start"
    );

    // A cancel of the transfer with this id. The test seeds the list by
    // hand, because a cancel reads an outbound row, and a receive writes the
    // list of an inbound row.
    let db3 = db();
    let stage = tempfile::tempdir().unwrap();
    let staging = daak_core::staging::Staging::new(stage.path().to_path_buf());
    let text = Manifest::text("cancel me");
    let id = daak_core::outbox::enqueue(&db3, &staging, &[3u8; 16], &text, &[]).unwrap();
    db3.set_setting(&format!("dest:{}", hex::encode(id)), b"\x80")
        .unwrap();
    daak_core::engine::cancel_with(&db3, &staging, id).unwrap();
    assert!(
        db3.get_setting(&format!("dest:{}", hex::encode(id)))
            .unwrap()
            .is_none(),
        "cancel"
    );
}

/// F4: two items are held, and the user deletes one held copy. Its row goes,
/// and the list stays. A file of the user then sits at the stored path. The
/// next delivery must not write into it: the item takes a suffix.
#[tokio::test]
async fn a_deleted_held_item_never_writes_into_a_user_file_at_its_stored_path() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let (manifest, paths) = folder(src.path());
    let db = db();

    // Pass 1: a.bin and b.bin are wrong, so both are held.
    let bad_dir = tempfile::tempdir().unwrap();
    let mut bad_paths = paths.clone();
    for (i, seed) in [(0usize, 1u8), (1, 2)] {
        let mut wrong = file_bytes(seed);
        wrong[5] ^= 0xff;
        let bad = bad_dir.path().join(format!("bad{i}"));
        std::fs::write(&bad, &wrong).unwrap();
        bad_paths[i] = Some(bad);
    }
    let (_, r, _) = resumed_pass(&manifest, &bad_paths, dst.path(), &db).await;
    assert!(
        matches!(r, Err(daak_core::CoreError::Quarantined { .. })),
        "got {r:?}"
    );
    assert!(db.get_setting(&list_key(&manifest)).unwrap().is_some());

    // The user deletes the held copy of a.bin. Then the user puts a file of
    // their own at album/a.bin.
    db.delete_item(&manifest.payload_id, 0).unwrap();
    let user = dst.path().join("album/a.bin");
    assert!(!user.exists(), "the quarantine moved the held copy");
    std::fs::write(&user, b"the user copy").unwrap();

    // Pass 2: the good bytes.
    let (_, r, _) = resumed_pass(&manifest, &paths, dst.path(), &db).await;
    r.unwrap();
    assert_eq!(std::fs::read(&user).unwrap(), b"the user copy");
    let row = db.get_item(&manifest.payload_id, 0).unwrap().unwrap();
    assert_eq!(row.state, "done");
    let landed = PathBuf::from(row.dest_path.unwrap());
    assert_eq!(landed, dst.path().join("album/a-1.bin"));
    assert_eq!(std::fs::read(&landed).unwrap(), file_bytes(1));
    let row = db.get_item(&manifest.payload_id, 1).unwrap().unwrap();
    assert_eq!(row.state, "done");
    assert_eq!(
        row.dest_path.as_deref(),
        dst.path().join("album/b.bin").to_str(),
        "the held item lands at its stored path"
    );
    assert_eq!(
        std::fs::read(dst.path().join("album/b.bin")).unwrap(),
        file_bytes(2)
    );
}
