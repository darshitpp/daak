//! Helpers for the resume tests (`folder_resume.rs` and `folder_retry.rs`).
//! Each test binary uses a different subset, so unused items are allowed.
#![allow(dead_code)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use daak_core::control::ResumeMsg;
use daak_core::framing::{Frame, RecordType};
use daak_core::manifest::{from_picked_paths, DeviceRef, Manifest, CHUNK_SIZE_MIN};
use daak_core::net::{tcp, FrameTransport};
use daak_core::store::Db;
use daak_core::transfer::{
    decode_chunk_body, encode_chunk_body, receive_transfer, send_transfer_resuming, RESUME_WAIT,
};

pub const CHUNK: usize = CHUNK_SIZE_MIN as usize;
/// 3 full chunks and a short fourth chunk.
pub const FILE_LEN: usize = CHUNK * 3 + 17;

pub fn sender_ref() -> DeviceRef {
    DeviceRef {
        device_id: [1u8; 16],
        name: "s".into(),
    }
}

pub fn file_bytes(seed: u8) -> Vec<u8> {
    bytes_of_len(seed, FILE_LEN)
}

pub fn bytes_of_len(seed: u8, len: usize) -> Vec<u8> {
    (0..len)
        .map(|i| ((i % 251) as u8).wrapping_add(seed))
        .collect()
}

/// A folder `album` with `a.bin`, `b.bin`, and `c.bin`. The manifest items are
/// in that order, so item 1 is `b.bin`.
pub fn folder(src: &Path) -> (Manifest, Vec<Option<PathBuf>>) {
    let root = src.join("album");
    std::fs::create_dir_all(&root).unwrap();
    for (name, seed) in [("a.bin", 1u8), ("b.bin", 2), ("c.bin", 3)] {
        std::fs::write(root.join(name), file_bytes(seed)).unwrap();
    }
    let (manifest, sources) = from_picked_paths(sender_ref(), &[root], CHUNK_SIZE_MIN).unwrap();
    let names: Vec<_> = manifest.items.iter().map(|i| i.name.clone()).collect();
    assert_eq!(names.len(), 3, "one item for each file: {names:?}");
    assert!(
        names[1].as_deref().unwrap().contains("b.bin"),
        "item 1 is b.bin: {names:?}"
    );
    (manifest, sources.into_iter().map(Some).collect())
}

pub fn db() -> Db {
    let db = Db::open_in_memory().unwrap();
    db.migrate().unwrap();
    db
}

/// Counts the chunk bytes that go out on the wire, for each item.
pub struct Tap<T> {
    pub inner: T,
    pub sent: Arc<Mutex<HashMap<u32, u64>>>,
}

impl<T: FrameTransport + Send> FrameTransport for Tap<T> {
    async fn send(
        &mut self,
        stream_id: u32,
        kind: RecordType,
        body: Bytes,
    ) -> daak_core::Result<()> {
        if kind == RecordType::Chunk {
            let (item, _chunk, data) = decode_chunk_body(&body)?;
            *self.sent.lock().unwrap().entry(item).or_default() += data.len() as u64;
        }
        self.inner.send(stream_id, kind, body).await
    }
    async fn recv(&mut self) -> daak_core::Result<Option<Frame>> {
        self.inner.recv().await
    }
}

/// Run the real resuming sender against the real receiver. Returns the chunk
/// bytes on the wire for each item, the sender result, and every progress value.
pub async fn resumed_pass(
    manifest: &Manifest,
    paths: &[Option<PathBuf>],
    out: &Path,
    db: &Db,
) -> (HashMap<u32, u64>, daak_core::Result<()>, Vec<u64>) {
    let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let sent = Arc::new(Mutex::new(HashMap::new()));
    let tap_sent = sent.clone();
    let m = manifest.clone();
    let p = paths.to_vec();
    let sender = tokio::spawn(async move {
        let (conn, _) = tcp::accept(&listener).await.unwrap();
        let mut tap = Tap {
            inner: conn,
            sent: tap_sent,
        };
        let mut progress = Vec::new();
        let r =
            send_transfer_resuming(&mut tap, &m, &p, Some(RESUME_WAIT), |n| progress.push(n)).await;
        (r, progress)
    });
    let mut conn = tcp::dial(addr).await.unwrap();
    let _ = tokio::time::timeout(
        Duration::from_secs(20),
        receive_transfer(&mut conn, out, |_| {}, Some(db), |_| {}),
    )
    .await
    .expect("the receive hung");
    let (r, progress) = sender.await.unwrap();
    let sent = sent.lock().unwrap().clone();
    (sent, r, progress)
}

/// Read frames until the first Nack, then decode it.
pub async fn read_resume<T: FrameTransport>(conn: &mut T) -> ResumeMsg {
    loop {
        let f = conn
            .recv()
            .await
            .unwrap()
            .expect("closed before the resume message");
        if f.kind == RecordType::Nack {
            return ResumeMsg::from_cbor(&f.body).unwrap();
        }
    }
}

pub async fn send_chunk<T: FrameTransport>(conn: &mut T, item: u32, chunk: u64, bytes: &[u8]) {
    let start = chunk as usize * CHUNK;
    let end = (start + CHUNK).min(bytes.len());
    let body = encode_chunk_body(item, chunk, &bytes[start..end]);
    conn.send(100 + item, RecordType::Chunk, Bytes::from(body))
        .await
        .unwrap();
}
