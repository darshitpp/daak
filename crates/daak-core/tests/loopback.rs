use std::path::PathBuf;

use daak_core::manifest::{DeviceRef, Item, Manifest, PayloadKind};
use daak_core::net::tcp;
use daak_core::transfer::{receive_transfer, send_transfer};

#[tokio::test]
async fn batch_of_many_files_roundtrips_over_tcp() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();

    let mut items = Vec::new();
    let mut paths: Vec<Option<PathBuf>> = Vec::new();
    for i in 0..10u32 {
        let p = src.path().join(format!("f{i}.bin"));
        let payload: Vec<u8> = (0..(50_000 + i)).map(|j| (j % 200) as u8).collect();
        std::fs::write(&p, &payload).unwrap();
        items.push(Item::from_file(i, &p, 64 * 1024).unwrap());
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
        send_transfer(&mut conn, &m, &paths, |_| {}).await.unwrap();
    });

    let mut conn = tcp::dial(addr).await.unwrap();
    let got = receive_transfer(&mut conn, dst.path(), |_| {})
        .await
        .unwrap();
    sender.await.unwrap();

    assert_eq!(got.kind, PayloadKind::Batch);
    assert_eq!(got.items.len(), 10);
    for i in 0..10u32 {
        let expected = std::fs::read(src.path().join(format!("f{i}.bin"))).unwrap();
        let actual = std::fs::read(dst.path().join(format!("f{i}.bin"))).unwrap();
        assert_eq!(expected, actual, "file {i} mismatch");
    }
}
