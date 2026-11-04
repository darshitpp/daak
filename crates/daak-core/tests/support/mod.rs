//! Helpers for the resume tests (`folder_resume.rs` and `folder_retry.rs`) and
//! the open file limit tests (`open_files_limit.rs`).
//! Each test binary uses a different subset, so unused items are allowed.
#![allow(dead_code)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use daak_core::control::{AckMsg, ResumeMsg};
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

/// The environment variable that tells a test that it runs in the child.
pub const CHILD_GUARD: &str = "DAAK_TEST_IN_CHILD";

/// True when this process is the child that `run_in_child_with_nofile` started.
pub fn in_child() -> bool {
    std::env::var_os(CHILD_GUARD).is_some()
}

/// Run the test `test_name` again in a child process with a soft limit of
/// `limit` open files. The child runs the real test body. This process
/// asserts that the child exits zero.
pub fn run_in_child_with_nofile(limit: u32, test_name: &str) {
    let exe = std::env::current_exe().unwrap();
    let script = format!("ulimit -n {limit} && exec \"$0\" --exact {test_name} --test-threads=1");
    let out = std::process::Command::new("sh")
        .arg("-c")
        .arg(script)
        .arg(exe)
        .env(CHILD_GUARD, "1")
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        out.status.success(),
        "the child failed at {limit} open files\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
    assert!(
        stdout.contains("1 passed"),
        "the child ran no test\nstdout:\n{stdout}"
    );
}

/// The version 100 receiver shape: the sender waits for no resume frame and
/// sends every chunk at once.
pub async fn send_without_resume_frame<T: FrameTransport>(
    conn: &mut T,
    manifest: &Manifest,
    paths: &[Option<PathBuf>],
    on_progress: impl FnMut(u64),
) -> daak_core::Result<()> {
    send_transfer_resuming(conn, manifest, paths, None, on_progress).await
}

/// A receiver with no socket. It keeps every chunk that the sender sends.
/// After each chunk it calls `after_chunk` with the item and chunk index.
/// Each `recv` returns a final good ack for the last manifest.
pub struct Sink {
    pub payload_id: [u8; 16],
    pub chunks: Vec<(u32, u64, Vec<u8>)>,
    pub after_chunk: Box<dyn FnMut(u32, u64) + Send>,
}

impl Sink {
    pub fn new() -> Self {
        Self::with_hook(|_, _| {})
    }

    pub fn with_hook(hook: impl FnMut(u32, u64) + Send + 'static) -> Self {
        Self {
            payload_id: [0u8; 16],
            chunks: Vec::new(),
            after_chunk: Box::new(hook),
        }
    }

    /// The bytes on the wire for one item, in chunk order.
    pub fn item_bytes(&self, item: u32) -> Vec<u8> {
        let mut parts: Vec<_> = self.chunks.iter().filter(|c| c.0 == item).collect();
        parts.sort_by_key(|c| c.1);
        parts.iter().flat_map(|c| c.2.iter().copied()).collect()
    }
}

impl FrameTransport for Sink {
    async fn send(
        &mut self,
        _stream_id: u32,
        kind: RecordType,
        body: Bytes,
    ) -> daak_core::Result<()> {
        match kind {
            RecordType::Manifest => self.payload_id = Manifest::from_cbor(&body)?.payload_id,
            RecordType::Chunk => {
                let (item, chunk, data) = decode_chunk_body(&body)?;
                self.chunks.push((item, chunk, data.to_vec()));
                (self.after_chunk)(item, chunk);
            }
            _ => {}
        }
        Ok(())
    }

    async fn recv(&mut self) -> daak_core::Result<Option<Frame>> {
        let ack = AckMsg {
            transfer_id: self.payload_id,
            item_index: 0,
            complete: true,
            hash_ok: true,
        };
        Ok(Some(Frame::new(
            daak_core::net::CONTROL_STREAM,
            RecordType::Ack,
            Bytes::from(ack.to_cbor()?),
        )))
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
