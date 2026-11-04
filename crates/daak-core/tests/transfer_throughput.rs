//! Loopback throughput tests. They record the send pipeline baseline.
//! The path wraps the TCP connection in `SecureConnection`, so it includes
//! the ChaChaPoly layer. The handshake is skipped. Both ends use one key.

use std::path::PathBuf;
use std::time::Instant;

use daak_core::manifest::CHUNK_SIZE_DEFAULT;
use daak_core::manifest::{DeviceRef, Item, Manifest};
use daak_core::net::secure::SecureConnection;
use daak_core::net::tcp;
use daak_core::transfer::{receive_transfer, send_transfer};

const MIB: u64 = 1024 * 1024;

/// Send `files` files of `total_mib / files` MiB each. Return (MiB/s, elapsed seconds).
async fn run(total_mib: u64, files: u32) -> (f64, f64) {
    // One scratch directory holds the sources, the output, and the quarantine.
    let scratch =
        PathBuf::from(std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".into())).join("daak");
    std::fs::create_dir_all(&scratch).unwrap();
    let dir = tempfile::Builder::new()
        .prefix("throughput-")
        .tempdir_in(&scratch)
        .unwrap();
    let src = dir.path().join("src");
    let out = dir.path().join("out");
    let quarantine = dir.path().join("quarantine");
    for d in [&src, &out, &quarantine] {
        std::fs::create_dir_all(d).unwrap();
    }

    let per_file = total_mib / u64::from(files) * MIB;
    let mut block = vec![0u8; MIB as usize];
    let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
    for b in block.iter_mut() {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        *b = x as u8;
    }
    let mut items = Vec::new();
    let mut paths: Vec<Option<PathBuf>> = Vec::new();
    for i in 0..files {
        let p = src.join(format!("f{i}.bin"));
        let mut data = Vec::with_capacity(per_file as usize);
        for _ in 0..per_file / MIB {
            data.extend_from_slice(&block);
        }
        std::fs::write(&p, &data).unwrap();
        items.push(Item::from_file(i, &p, CHUNK_SIZE_DEFAULT).unwrap());
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

    let key = [7u8; 32];
    let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let m = manifest.clone();
    let start = Instant::now();
    let sender = tokio::spawn(async move {
        let (conn, _) = tcp::accept(&listener).await.unwrap();
        let mut conn = SecureConnection::new(conn, key, key);
        send_transfer(&mut conn, &m, &paths, &[], |_| {})
            .await
            .unwrap();
    });
    let conn = tcp::dial(addr).await.unwrap();
    let mut conn = SecureConnection::new(conn, key, key);
    let got = receive_transfer(&mut conn, &out, |_| {}, None, |_| {})
        .await
        .unwrap();
    sender.await.unwrap();
    let secs = start.elapsed().as_secs_f64();

    assert_eq!(got.items.len(), files as usize);
    for i in 0..files {
        let len = std::fs::metadata(out.join(format!("f{i}.bin")))
            .unwrap()
            .len();
        assert_eq!(len, per_file, "file {i} has the wrong size");
    }
    ((total_mib as f64) / secs, secs)
}

/// 64 MiB in 8 files. The floor of 1 MiB/s catches a hang only.
/// It does not compare runs.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn throughput_report() {
    let (rate, secs) = run(64, 8).await;
    println!("throughput_report: {rate:.2} MiB/s in {secs:.2} s (64 MiB, 8 files, loopback, encryption included)");
    assert!(rate >= 1.0, "rate {rate:.2} MiB/s is below 1 MiB/s");
}

/// 512 MiB in 64 files. It runs only when `DAAK_PERF=1`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn throughput_large() {
    if std::env::var("DAAK_PERF").as_deref() != Ok("1") {
        return;
    }
    let (rate, secs) = run(512, 64).await;
    println!(
        "throughput_large: {rate:.2} MiB/s in {secs:.2} s (512 MiB, 64 files, loopback, encryption included)"
    );
}
