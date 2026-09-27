use std::path::PathBuf;

use daak_core::manifest::CHUNK_SIZE_DEFAULT;
use daak_core::manifest::{DeviceRef, Item, Manifest, PayloadKind};
use daak_core::net::tcp;
use daak_core::transfer::{receive_transfer, send_transfer};

/// Run with: DAAK_BIG_TEST=1 cargo test -p daak-core --test loopback -- --ignored --nocapture
#[tokio::test]
#[ignore = "4 GiB; opt in with DAAK_BIG_TEST=1"]
async fn transfers_four_gibibytes_with_bounded_memory() {
    if std::env::var("DAAK_BIG_TEST").as_deref() != Ok("1") {
        return;
    }

    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let path = src.path().join("big.bin");
    let f = std::fs::File::create(&path).unwrap();
    f.set_len(4 * 1024 * 1024 * 1024).unwrap();

    let item = Item::from_file(0, &path, CHUNK_SIZE_DEFAULT).unwrap();
    let manifest = Manifest::new(
        PayloadKind::Media,
        DeviceRef {
            device_id: [1u8; 16],
            name: "s".into(),
        },
        vec![item],
    );

    let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let m = manifest.clone();
    let p = path.clone();
    let sender = tokio::spawn(async move {
        let (mut conn, _) = tcp::accept(&listener).await.unwrap();
        send_transfer(&mut conn, &m, &[Some(p)], &[], |_| {})
            .await
            .unwrap();
    });

    let mut conn = tcp::dial(addr).await.unwrap();
    receive_transfer(&mut conn, dst.path(), |_| {}, None, |_| {})
        .await
        .unwrap();
    sender.await.unwrap();
    assert_eq!(
        std::fs::metadata(dst.path().join("big.bin")).unwrap().len(),
        4 * 1024 * 1024 * 1024
    );
    // Memory flatness is validated by the ChunkReader bounded-buffer unit test in
    // chunk::reader; when running this test, watch RSS with cargo test + top
    // and confirm it stays in the low hundreds of MiB.
}

/// W-FW-3: exit criterion 3, at the stated scale of 100 files with varying
/// sizes. What this proves: 100 mixed-size items, every byte correct, through
/// the real TCP transport. What it does NOT prove: scheduling ORDER -- the wire
/// carries no completion signal per item, so fairness (small files finish
/// first) is proven by the scheduler unit tests in transfer/scheduler.rs, not
/// here. Observing order at the transport layer needs an instrumentation hook
/// that Phase 4+ can add when a UI progress bar actually needs it.
#[tokio::test]
async fn a_hundred_file_batch_roundtrips_over_tcp() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();

    let mut items = Vec::new();
    let mut paths: Vec<Option<PathBuf>> = Vec::new();
    for i in 0..100u32 {
        let p = src.path().join(format!("f{i}.bin"));
        let payload: Vec<u8> = (0..(50_000 + i)).map(|j| (j % 200) as u8).collect();
        std::fs::write(&p, &payload).unwrap();
        // 1 MiB chunks (the wire default) against ~50 KB items would be one
        // chunk each, so the 100-item run would never exercise interleaving.
        // A 4 KiB chunk size makes every item ~13 chunks, so the scheduler is
        // genuinely round-robining 100 streams.
        items.push(Item::from_file(i, &p, 4 * 1024).unwrap());
        paths.push(Some(p));
    }
    let manifest = Manifest::batch(
        DeviceRef {
            device_id: [1u8; 16],
            name: "s".into(),
        },
        items,
    )
    .unwrap();

    let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let m = manifest.clone();
    let sender = tokio::spawn(async move {
        let (mut conn, _) = tcp::accept(&listener).await.unwrap();
        send_transfer(&mut conn, &m, &paths, &[], |_| {})
            .await
            .unwrap();
    });

    let mut conn = tcp::dial(addr).await.unwrap();
    let got = receive_transfer(&mut conn, dst.path(), |_| {}, None, |_| {})
        .await
        .unwrap();
    sender.await.unwrap();

    assert_eq!(got.kind, PayloadKind::Batch);
    assert_eq!(got.items.len(), 100);
    for i in 0..100u32 {
        let expected = std::fs::read(src.path().join(format!("f{i}.bin"))).unwrap();
        let actual = std::fs::read(dst.path().join(format!("f{i}.bin"))).unwrap();
        assert_eq!(expected, actual, "file {i} mismatch");
    }
}
