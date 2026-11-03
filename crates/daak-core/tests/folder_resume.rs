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

use std::time::{Duration, Instant};

use bytes::Bytes;
use daak_core::control::AckMsg;
use daak_core::framing::RecordType;
use daak_core::manifest::Manifest;
use daak_core::net::{tcp, CONTROL_STREAM};
use daak_core::store::inbox::InboxRow;
use daak_core::transfer::{
    decode_chunk_body, receive_transfer, resume_wait, send_transfer, send_transfer_resuming,
    RESUME_WAIT,
};
use support::{db, file_bytes, folder, read_resume, resumed_pass, send_chunk, CHUNK, FILE_LEN};

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
