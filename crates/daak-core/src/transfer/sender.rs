use std::path::{Path, PathBuf};
use std::time::Duration;

use bytes::{BufMut, Bytes, BytesMut};

use crate::control::{AckMsg, ResumeMsg};
use crate::error::{CoreError, Result};
use crate::framing::RecordType;
use crate::manifest::{clamp_chunk_size, Manifest, CHUNK_SIZE_DEFAULT};
use crate::net::{FrameTransport, CONTROL_STREAM};
use crate::transfer::receiver::RESUME_MSG_MAX;
use crate::transfer::scheduler::{interleave, ScheduledItem};

pub fn encode_chunk_body(item_index: u32, chunk_index: u64, data: &[u8]) -> Vec<u8> {
    let mut out = BytesMut::with_capacity(16 + data.len());
    out.put_u32(item_index);
    out.put_u64(chunk_index);
    out.put_u32(data.len() as u32);
    out.put_slice(data);
    out.to_vec()
}

pub fn decode_chunk_body(body: &[u8]) -> Result<(u32, u64, Bytes)> {
    if body.len() < 16 {
        return Err(CoreError::Protocol("chunk body shorter than header".into()));
    }
    let item_index = u32::from_be_bytes([body[0], body[1], body[2], body[3]]);
    let chunk_index = u64::from_be_bytes([
        body[4], body[5], body[6], body[7], body[8], body[9], body[10], body[11],
    ]);
    let data_len = u32::from_be_bytes([body[12], body[13], body[14], body[15]]) as usize;
    if body.len() != 16 + data_len {
        return Err(CoreError::Protocol("chunk body length mismatch".into()));
    }
    Ok((item_index, chunk_index, Bytes::copy_from_slice(&body[16..])))
}

/// The first protocol version whose receiver sends a `ResumeMsg`.
pub const RESUME_MIN_VERSION: u16 = 101;

/// The time that a sender waits for the `ResumeMsg` of a version 101 peer.
/// When no frame arrives in this time, the sender sends every chunk.
pub const RESUME_WAIT: Duration = Duration::from_secs(10);

/// The resume wait for a peer with this announced version. A peer that
/// announced 100, or a peer with no known version, gets no wait.
pub fn resume_wait(peer_version: Option<u16>) -> Option<Duration> {
    peer_version
        .filter(|v| *v >= RESUME_MIN_VERSION)
        .map(|_| RESUME_WAIT)
}

/// Send the manifest, then the chunks inside `ranges`, then read the ack.
/// This is the version 100 sender: it reads no frame before its ack loop.
#[tracing::instrument(
    name = "send",
    skip_all,
    fields(
        payload = %crate::diag::short_id(&manifest.payload_id),
        bytes = tracing::field::Empty
    )
)]
pub async fn send_transfer<T: FrameTransport>(
    conn: &mut T,
    manifest: &Manifest,
    paths: &[Option<PathBuf>],
    // Per-item half-open chunk ranges; &[] or a missing entry = all chunks, a
    // present-but-empty entry = none (R-T7-4). An invalid list gives a full send.
    ranges: &[Vec<(u64, u64)>],
    on_progress: impl FnMut(u64),
) -> Result<()> {
    send_manifest(conn, manifest).await?;
    stream_and_await_ack(conn, manifest, paths, ranges, on_progress).await
}

/// Send the manifest, then wait up to `wait` for the receiver's `ResumeMsg`.
/// Then send only the chunks that the message names, and read the ack.
///
/// `wait` is `None` for a peer that does not send a `ResumeMsg`. The sender
/// then sends every chunk at once. When no frame arrives in `wait`, the sender
/// also sends every chunk.
///
/// When the receiver already holds bytes, `on_progress` first gets that byte
/// count, once. Each later call is the length of one chunk on the wire. So the
/// sum of all calls is the transfer total.
#[tracing::instrument(
    name = "send",
    skip_all,
    fields(
        payload = %crate::diag::short_id(&manifest.payload_id),
        bytes = tracing::field::Empty
    )
)]
pub async fn send_transfer_resuming<T: FrameTransport>(
    conn: &mut T,
    manifest: &Manifest,
    paths: &[Option<PathBuf>],
    wait: Option<Duration>,
    mut on_progress: impl FnMut(u64),
) -> Result<()> {
    send_manifest(conn, manifest).await?;
    let ranges = match wait {
        None => Vec::new(),
        Some(wait) => match await_resume(conn, manifest, wait).await? {
            Resume::Ranges(r) => r,
            Resume::TimedOut => {
                tracing::info!("no resume message; the sender sends every chunk");
                Vec::new()
            }
            Resume::Done(verdict) => return verdict,
        },
    };
    let held = bytes_held(manifest, &ranges);
    if held > 0 {
        on_progress(held);
    }
    stream_and_await_ack(conn, manifest, paths, &ranges, on_progress).await
}

async fn send_manifest<T: FrameTransport>(conn: &mut T, manifest: &Manifest) -> Result<()> {
    conn.send(
        CONTROL_STREAM,
        RecordType::Manifest,
        Bytes::from(manifest.to_cbor()?),
    )
    .await
}

enum Resume {
    /// The receiver named the chunks that it needs.
    Ranges(Vec<Vec<(u64, u64)>>),
    /// No resume message arrived in time.
    TimedOut,
    /// The receiver sent its final ack before any chunk. This is the verdict.
    Done(Result<()>),
}

/// Read frames until the `ResumeMsg`, a final ack, or the deadline.
async fn await_resume<T: FrameTransport>(
    conn: &mut T,
    manifest: &Manifest,
    wait: Duration,
) -> Result<Resume> {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        // The frame codec keeps a partial frame in its buffer, so a timeout
        // here does not lose bytes. The ack loop reads the frame later.
        let frame = match tokio::time::timeout_at(deadline, conn.recv()).await {
            Err(_) => return Ok(Resume::TimedOut),
            Ok(frame) => frame?,
        };
        match frame {
            Some(f) if f.kind == RecordType::Nack => {
                // F1: a body above the limit is not decoded. A legitimate
                // receiver never sends one. The sender then sends every chunk.
                if f.body.len() > RESUME_MSG_MAX {
                    tracing::info!("resume message too large; the sender sends every chunk");
                    return Ok(Resume::Ranges(Vec::new()));
                }
                let Ok(msg) = ResumeMsg::from_cbor(&f.body) else {
                    tracing::info!("resume message not valid; the sender sends every chunk");
                    return Ok(Resume::Ranges(Vec::new()));
                };
                if msg.transfer_id != manifest.payload_id {
                    return Err(CoreError::Protocol(
                        "resume message for a different transfer".into(),
                    ));
                }
                return Ok(Resume::Ranges(clean_ranges(manifest, msg.ranges)));
            }
            Some(f) if f.kind == RecordType::Ack => {
                if let Some(verdict) = ack_verdict(manifest, &AckMsg::from_cbor(&f.body)?) {
                    return Ok(Resume::Done(verdict));
                }
            }
            Some(_) => continue,
            None => {
                return Err(CoreError::Protocol(
                    "connection closed before transfer ack".into(),
                ))
            }
        }
    }
}

/// The most ranges that one item can have in a valid list.
const MAX_RANGES_PER_ITEM: usize = 1024;

/// Check and merge the ranges of a resume message. The result is empty when
/// the list is not valid. An empty list means "send every chunk". An item
/// list is not valid when it has more than 1024 ranges. A range is not valid
/// when it is empty, reversed, or past the chunk count of its item. For a
/// valid list, each item list is sorted and merged once.
fn clean_ranges(m: &Manifest, ranges: Vec<Vec<(u64, u64)>>) -> Vec<Vec<(u64, u64)>> {
    let mut cleaned = Vec::with_capacity(ranges.len());
    for (index, mut list) in ranges.into_iter().enumerate() {
        let chunk_count = m
            .items
            .get(index)
            .and_then(|item| item.chunk_count)
            .unwrap_or(0);
        let valid = list.len() <= MAX_RANGES_PER_ITEM
            && list
                .iter()
                .all(|&(start, end)| start < end && end <= chunk_count);
        if !valid {
            return Vec::new();
        }
        list.sort_unstable();
        let mut merged: Vec<(u64, u64)> = Vec::with_capacity(list.len());
        for (start, end) in list {
            match merged.last_mut() {
                Some(last) if start <= last.1 => last.1 = last.1.max(end),
                _ => merged.push((start, end)),
            }
        }
        cleaned.push(merged);
    }
    cleaned
}

/// The bytes that the receiver already holds: for each binary item with a
/// list, the item size less the bytes inside its ranges. An item with no
/// list holds 0 bytes, because the sender sends all of it.
fn bytes_held(manifest: &Manifest, ranges: &[Vec<(u64, u64)>]) -> u64 {
    manifest
        .binary_items()
        .filter_map(|item| {
            let wanted = ranges.get(item.index as usize)?;
            let size = item.size?;
            let chunk = item.chunk_size.unwrap_or(CHUNK_SIZE_DEFAULT) as u64;
            let missing: u64 = wanted
                .iter()
                .map(|&(start, end)| {
                    let lo = start.saturating_mul(chunk).min(size);
                    let hi = end.saturating_mul(chunk).min(size);
                    hi.saturating_sub(lo)
                })
                .fold(0u64, u64::saturating_add);
            Some(size.saturating_sub(missing))
        })
        .fold(0u64, u64::saturating_add)
}

/// The result that a final ack gives, or `None` when the ack is not final.
fn ack_verdict(manifest: &Manifest, ack: &AckMsg) -> Option<Result<()>> {
    // Never trust the caller-side convention that only one transfer is in
    // flight per connection: an Ack for another transfer is a protocol
    // violation, and skipping it would hang on an Ack that is never coming.
    if ack.transfer_id != manifest.payload_id {
        return Some(Err(CoreError::Protocol(
            "ack for a different transfer".into(),
        )));
    }
    if !ack.complete {
        return None;
    }
    if !ack.hash_ok {
        // B4: a quarantine, not a transfer failure. The receiver got every
        // byte and hashed it; the verdict is about THESE bytes. Naming the
        // item keeps the caller from having to parse the message to find it.
        return Some(Err(CoreError::Quarantined {
            transfer_id: manifest.payload_id,
            item_index: ack.item_index,
        }));
    }
    Some(Ok(()))
}

/// The capacity of the channel between the reader task and the send loop.
pub(crate) const READ_AHEAD: usize = 2;

async fn stream_and_await_ack<T: FrameTransport>(
    conn: &mut T,
    manifest: &Manifest,
    paths: &[Option<PathBuf>],
    ranges: &[Vec<(u64, u64)>],
    on_progress: impl FnMut(u64),
) -> Result<()> {
    stream_and_await_ack_with(conn, manifest, paths, ranges, on_progress, || {}).await
}

/// `stream_and_await_ack` with a test hook. The reader task calls
/// `read_hook` before each chunk read.
pub(crate) async fn stream_and_await_ack_with<T: FrameTransport>(
    conn: &mut T,
    manifest: &Manifest,
    paths: &[Option<PathBuf>],
    ranges: &[Vec<(u64, u64)>],
    mut on_progress: impl FnMut(u64),
    read_hook: impl Fn() + Send + Sync + 'static,
) -> Result<()> {
    // F1: every caller gets cleaned ranges, also a caller of `send_transfer`.
    let ranges = &clean_ranges(manifest, ranges.to_vec());
    let mut scheduled = Vec::with_capacity(manifest.items.len());
    // F2: the sender holds no file handle between chunks. This local list keeps,
    // for each item index, the path, the chunk size, and the file identity.
    let mut files: Vec<Option<(PathBuf, u64, FileId)>> = vec![None; manifest.items.len()];
    for item in &manifest.items {
        if !item.is_binary() {
            continue;
        }
        let path = paths
            .get(item.index as usize)
            .and_then(|p| p.clone())
            .ok_or_else(|| CoreError::Transfer(format!("missing path for item {}", item.index)))?;
        let chunk_size = clamp_chunk_size(item.chunk_size.unwrap_or(CHUNK_SIZE_DEFAULT));
        let chunk_count = item.chunk_count.ok_or_else(|| {
            CoreError::Transfer(format!("item {} missing chunk_count", item.index))
        })?;
        let slot = files.get_mut(item.index as usize).ok_or_else(|| {
            CoreError::Transfer(format!("item index {} is out of range", item.index))
        })?;
        // A picked path can be a symlink to a file. Resolve it once here. Each
        // chunk opens the resolved path with `O_NOFOLLOW`, so a later swap fails.
        let path = tokio::fs::canonicalize(&path).await?;
        let id = file_id(&tokio::fs::symlink_metadata(&path).await?);
        // The manifest holds the size at build time. A file that grew since
        // then sends bytes past that size in its last chunk. So the size now
        // must equal the manifest size before the first chunk goes out.
        if item.size != Some(id.0) {
            return Err(CoreError::Transfer(
                "the source file changed during the send".into(),
            ));
        }
        *slot = Some((path.clone(), chunk_size as u64, id));
        scheduled.push(ScheduledItem {
            index: item.index,
            path,
            chunk_size,
            chunk_count,
        });
    }

    let order: Vec<(u32, u64)> = interleave(scheduled, 1)
        .into_iter()
        .filter(|&(item, chunk)| chunk_in_ranges(ranges, item, chunk))
        .collect();

    // One reader task reads the chunks in wire order. The channel holds up to
    // READ_AHEAD chunks, so the reader reads the next chunk while the loop
    // below sends the current one. The reader stops after the first error.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<(u32, u64, Vec<u8>)>>(READ_AHEAD);
    let reader = tokio::task::spawn_blocking(move || {
        for (item_index, chunk_index) in order {
            read_hook();
            // F2: each chunk opens the file again with its own checks.
            let read = files
                .get(item_index as usize)
                .cloned()
                .flatten()
                .ok_or_else(|| CoreError::Transfer(format!("no source for item {item_index}")))
                .and_then(|(path, chunk_size, want)| {
                    read_chunk_checked(&path, chunk_size, chunk_index, want)
                })
                .map(|data| (item_index, chunk_index, data));
            let failed = read.is_err();
            // A send error means that the loop stopped. The reader then ends.
            if tx.blocking_send(read).is_err() || failed {
                return;
            }
        }
    });

    let streamed = async {
        // One total for the span. No event for each chunk.
        let mut sent: u64 = 0;
        while let Some(read) = rx.recv().await {
            let (item_index, chunk_index, data) = read?;
            let body = encode_chunk_body(item_index, chunk_index, &data);
            conn.send(
                crate::session::item_stream(item_index),
                RecordType::Chunk,
                Bytes::from(body),
            )
            .await?;
            // The progress follows the wire, so it runs after the send.
            on_progress(data.len() as u64);
            sent += data.len() as u64;
        }
        Ok::<u64, CoreError>(sent)
    }
    .await;
    // On every exit: close the channel, then wait for the reader once. A
    // reader in a file read ends after that read.
    drop(rx);
    let joined = reader.await;
    let sent = streamed?;
    joined.map_err(|e| CoreError::Transfer(format!("chunk read task failed: {e}")))?;
    tracing::Span::current().record("bytes", sent);

    loop {
        match conn.recv().await? {
            Some(f) if f.kind == RecordType::Ack => {
                if let Some(verdict) = ack_verdict(manifest, &AckMsg::from_cbor(&f.body)?) {
                    return verdict;
                }
            }
            // A version 101 receiver sends a ResumeMsg (Nack) first. This
            // loop skips it, like every other kind it does not know.
            Some(_) => continue,
            None => {
                return Err(CoreError::Protocol(
                    "connection closed before transfer ack".into(),
                ))
            }
        }
    }
}

/// The size of a source file and, on unix, its device and inode.
type FileId = (u64, Option<(u64, u64)>);

fn file_id(meta: &std::fs::Metadata) -> FileId {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (meta.len(), Some((meta.dev(), meta.ino())))
    }
    #[cfg(not(unix))]
    {
        (meta.len(), None)
    }
}

/// Read chunk `index` of the source file at `path`, then close the file.
///
/// On unix the open uses `O_NOFOLLOW`, so a symlink at the last component
/// fails. The size, device, and inode of the open handle must equal `want`.
/// A different value fails the transfer. The error text holds no file name.
fn read_chunk_checked(
    path: &Path,
    chunk_size: u64,
    index: u64,
    want: (u64, Option<(u64, u64)>),
) -> Result<Vec<u8>> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path)?;
    if file_id(&file.metadata()?) != want {
        return Err(CoreError::Transfer(
            "the source file changed during the send".into(),
        ));
    }
    let offset = chunk_size
        .checked_mul(index)
        .filter(|offset| *offset < want.0)
        .ok_or_else(|| CoreError::Transfer(format!("chunk {index} missing")))?;
    let len = (want.0 - offset).min(chunk_size);
    read_at(&mut file, offset, len)
}

/// Read `len` bytes at `offset`. A short read means that the file got shorter
/// after the file id check. That is a source change, so the error is the
/// same as the error of the id check.
fn read_at(
    file: &mut (impl std::io::Read + std::io::Seek),
    offset: u64,
    len: u64,
) -> Result<Vec<u8>> {
    file.seek(std::io::SeekFrom::Start(offset))?;
    let mut data = vec![0u8; len as usize];
    file.read_exact(&mut data).map_err(|e| {
        if e.kind() == std::io::ErrorKind::UnexpectedEof {
            CoreError::Transfer("the source file changed during the send".into())
        } else {
            e.into()
        }
    })?;
    Ok(data)
}

/// True when the chunk is in scope for this transfer. An empty top-level
/// 'ranges' slice, or a MISSING per-item entry, means "send all chunks". A
/// PRESENT-BUT-EMPTY per-item list means "send nothing" (R-T7-4): that item was
/// already fully received, so it never appears in a NACK -- re-sending it is
/// exactly the duplicate the resume path must avoid. Otherwise a chunk is sent
/// iff it falls inside a half-open [start, end) range.
fn chunk_in_ranges(ranges: &[Vec<(u64, u64)>], item_index: u32, chunk_index: u64) -> bool {
    let Some(item_ranges) = ranges.get(item_index as usize) else {
        return true;
    };
    item_ranges
        .iter()
        .any(|&(start, end)| chunk_index >= start && chunk_index < end)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::framing::RecordType;
    use crate::manifest::{DeviceRef, Item, PayloadKind, CHUNK_SIZE_MIN};
    use crate::net::secure::{MemConn, SecureConnection};
    use crate::net::tcp;

    fn sender() -> DeviceRef {
        DeviceRef {
            device_id: [1u8; 16],
            name: "sender".into(),
        }
    }

    /// Drives `send_transfer` over a real (socket-free) peer that answers with
    /// ONE ack, so the ack loop's verdict is observable without a port.
    async fn send_to_ack(
        ack: impl FnOnce([u8; 16]) -> AckMsg + Send + 'static,
    ) -> (Result<()>, Manifest) {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.bin");
        std::fs::write(&p, vec![5u8; 2_000]).unwrap();
        let item = Item::from_file(0, &p, 64 * 1024).unwrap();
        let manifest = Manifest::new(PayloadKind::Media, sender(), vec![item]);

        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let m = manifest.clone();
        let path = p.clone();
        let peer = tokio::spawn(async move {
            // Drain the manifest + every chunk, then answer with the ack the
            // test asked for. No socket, so this runs in any sandbox.
            let mut chunks = 0usize;
            loop {
                match theirs.recv().await {
                    Ok(Some(f)) if f.kind == RecordType::Chunk => chunks += 1,
                    Ok(Some(_)) => {}
                    Ok(None) => return,
                    Err(_) => return,
                }
                if chunks == 1 {
                    let a = ack(m.payload_id);
                    theirs
                        .send(
                            crate::net::CONTROL_STREAM,
                            RecordType::Ack,
                            bytes::Bytes::from(a.to_cbor().unwrap()),
                        )
                        .await
                        .unwrap();
                    return;
                }
            }
        });
        let r = send_transfer(&mut mine, &manifest, &[Some(path)], &[], |_| {}).await;
        peer.await.unwrap();
        (r, manifest)
    }

    /// The result of a send against a peer that answers with one resume body.
    struct ResumeRun {
        result: Result<()>,
        /// The chunk indexes that the peer got, in order.
        chunks: Vec<u64>,
        /// The `on_progress` values, in order.
        progress: Vec<u64>,
        /// The item size in bytes.
        size: u64,
    }

    const RESUME_CHUNKS: u64 = 100;

    /// Send one item of 100 chunks. The peer sends `body` as the resume frame,
    /// then a final ack, then counts every chunk until the sender closes.
    async fn send_with_resume_body(
        body: impl FnOnce([u8; 16]) -> Vec<u8> + Send + 'static,
    ) -> ResumeRun {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.bin");
        let size = RESUME_CHUNKS * CHUNK_SIZE_MIN as u64;
        std::fs::write(&p, vec![3u8; size as usize]).unwrap();
        let item = Item::from_file(0, &p, CHUNK_SIZE_MIN).unwrap();
        assert_eq!(item.chunk_count, Some(RESUME_CHUNKS));
        let manifest = Manifest::new(PayloadKind::Media, sender(), vec![item]);

        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let id = manifest.payload_id;
        let peer = tokio::spawn(async move {
            let first = theirs.recv().await.unwrap().unwrap();
            assert_eq!(first.kind, RecordType::Manifest);
            theirs
                .send(CONTROL_STREAM, RecordType::Nack, Bytes::from(body(id)))
                .await
                .unwrap();
            let ack = AckMsg {
                transfer_id: id,
                item_index: 0,
                complete: true,
                hash_ok: true,
            };
            theirs
                .send(
                    CONTROL_STREAM,
                    RecordType::Ack,
                    Bytes::from(ack.to_cbor().unwrap()),
                )
                .await
                .unwrap();
            let mut chunks = Vec::new();
            while let Ok(Some(f)) = theirs.recv().await {
                if f.kind == RecordType::Chunk {
                    chunks.push(decode_chunk_body(&f.body).unwrap().1);
                }
            }
            chunks
        });
        let mut progress = Vec::new();
        let result = send_transfer_resuming(
            &mut mine,
            &manifest,
            &[Some(p)],
            Some(Duration::from_secs(30)),
            |n| progress.push(n),
        )
        .await;
        drop(mine);
        let chunks = peer.await.unwrap();
        ResumeRun {
            result,
            chunks,
            progress,
            size,
        }
    }

    fn resume_cbor(id: [u8; 16], ranges: Vec<Vec<(u64, u64)>>) -> Vec<u8> {
        ResumeMsg {
            transfer_id: id,
            ranges,
        }
        .to_cbor()
        .unwrap()
    }

    fn all_chunks() -> Vec<u64> {
        (0..RESUME_CHUNKS).collect()
    }

    /// A resume body over `RESUME_MSG_MAX` is not decoded. This body is valid
    /// CBOR for another transfer. A decode would fail the send.
    #[tokio::test]
    async fn a_resume_body_over_64_kib_gives_a_full_send_and_is_not_decoded() {
        let run = send_with_resume_body(|_| {
            let ranges = vec![vec![(0, 1)]; 1];
            let mut body = resume_cbor([9u8; 16], ranges);
            body.resize(crate::transfer::receiver::RESUME_MSG_MAX + 1, 0);
            body
        })
        .await;
        run.result.unwrap();
        assert_eq!(run.chunks, all_chunks());
    }

    #[tokio::test]
    async fn a_resume_body_that_is_not_cbor_gives_a_full_send() {
        let run = send_with_resume_body(|_| vec![0xff; 40]).await;
        run.result.unwrap();
        assert_eq!(run.chunks, all_chunks());
    }

    #[tokio::test]
    async fn a_list_with_more_than_1024_ranges_for_one_item_gives_a_full_send() {
        let run = send_with_resume_body(|id| resume_cbor(id, vec![vec![(0, 1); 1025]])).await;
        run.result.unwrap();
        assert_eq!(run.chunks, all_chunks());
        assert!(run.progress.iter().all(|n| *n <= CHUNK_SIZE_MIN as u64));
    }

    #[tokio::test]
    async fn an_empty_reversed_or_late_range_gives_a_full_send() {
        for bad in [(5, 5), (7, 3), (90, 101)] {
            let run =
                send_with_resume_body(move |id| resume_cbor(id, vec![vec![(0, 2), bad]])).await;
            run.result.unwrap();
            assert_eq!(run.chunks, all_chunks(), "range {bad:?}");
        }
    }

    #[tokio::test]
    async fn a_thousand_overlapping_ranges_for_an_item_of_100_chunks_send_the_right_chunks_and_count_bytes_once(
    ) {
        // The union of the ranges is chunks 0 to 49.
        let ranges: Vec<(u64, u64)> = (0..1000u64).map(|k| (k % 41, k % 41 + 10)).collect();
        let run = send_with_resume_body(move |id| resume_cbor(id, vec![ranges])).await;
        run.result.unwrap();
        assert_eq!(run.chunks, (0..50).collect::<Vec<u64>>());
        assert_eq!(
            run.progress.first().copied(),
            Some(run.size - 50 * CHUNK_SIZE_MIN as u64),
            "the held bytes count each chunk once"
        );
    }

    /// Pin: a resume message for another transfer still gives an error.
    #[tokio::test]
    async fn a_transfer_id_mismatch_still_returns_an_error() {
        let run = send_with_resume_body(|_| resume_cbor([9u8; 16], vec![])).await;
        assert!(matches!(run.result, Err(CoreError::Protocol(_))));
    }

    /// Pin: an item list with no range stays in the result. It means "send
    /// nothing for this item".
    #[test]
    fn clean_ranges_keeps_an_empty_item_list_as_complete() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.bin");
        std::fs::write(&p, vec![5u8; 2_000]).unwrap();
        let item = Item::from_file(0, &p, 64 * 1024).unwrap();
        assert!(item.chunk_count.unwrap_or(0) > 0);
        let manifest = Manifest::new(PayloadKind::Media, sender(), vec![item]);
        assert_eq!(
            clean_ranges(&manifest, vec![vec![]]),
            vec![Vec::<(u64, u64)>::new()]
        );
    }

    /// Pin: two ranges that touch at one chunk index merge into one range.
    #[test]
    fn clean_ranges_merges_adjacent_half_open_ranges() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.bin");
        std::fs::write(&p, vec![5u8; 2_000]).unwrap();
        let mut item = Item::from_file(0, &p, 64 * 1024).unwrap();
        item.chunk_count = Some(9);
        let manifest = Manifest::new(PayloadKind::Media, sender(), vec![item]);
        assert_eq!(
            clean_ranges(&manifest, vec![vec![(0, 5), (5, 9)]]),
            vec![vec![(0, 9)]]
        );
    }

    #[test]
    fn chunk_in_ranges_sends_all_when_empty_or_matches() {
        // Empty top-level ranges => every chunk in scope.
        assert!(chunk_in_ranges(&[], 0, 999));
        // Present-but-empty per-item list => send NOTHING (R-T7-4): a fully
        // received item is absent from the NACK, and re-sending is a duplicate.
        assert!(!chunk_in_ranges(&[vec![]], 0, 999));
        // A non-empty list filters to half-open [start, end).
        assert!(chunk_in_ranges(&[vec![(2, 5)]], 0, 2));
        assert!(chunk_in_ranges(&[vec![(2, 5)]], 0, 4));
        assert!(!chunk_in_ranges(&[vec![(2, 5)]], 0, 5));
        assert!(!chunk_in_ranges(&[vec![(2, 5)]], 0, 1));
        // Item without an entry => send all.
        assert!(chunk_in_ranges(&[vec![(2, 5)]], 1, 7));
    }

    /// F2: each read gives one chunk at most, and the last chunk is short.
    /// This test replaces the tests of the old chunk reader.
    #[test]
    fn read_chunk_checked_gives_one_chunk_and_a_short_last_chunk() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f.bin");
        let bytes: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&p, &bytes).unwrap();
        let want = file_id(&std::fs::metadata(&p).unwrap());
        let chunk = 64 * 1024u64;
        let c0 = read_chunk_checked(&p, chunk, 0, want).unwrap();
        let c1 = read_chunk_checked(&p, chunk, 1, want).unwrap();
        assert_eq!(c0, bytes[..chunk as usize]);
        assert_eq!(c1, bytes[chunk as usize..]);
        assert!(read_chunk_checked(&p, chunk, 2, want).is_err());
        let other = (want.0 + 1, want.1);
        assert!(matches!(
            read_chunk_checked(&p, chunk, 0, other),
            Err(CoreError::Transfer(_))
        ));
    }

    /// The source file grows after the manifest is built. The sender must
    /// fail before the first chunk. Otherwise the last chunk carries bytes past
    /// the manifest size to the peer.
    #[tokio::test]
    async fn a_source_file_that_changed_size_after_the_manifest_fails_before_any_chunk_is_sent() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.bin");
        std::fs::write(&p, vec![5u8; 100_000]).unwrap();
        let item = Item::from_file(0, &p, 64 * 1024).unwrap();
        let chunk_count = item.chunk_count.unwrap() as usize;
        let manifest = Manifest::new(PayloadKind::Media, sender(), vec![item]);
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
            f.write_all(&[9u8; 10_000]).unwrap();
        }

        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let peer = tokio::spawn(async move {
            let mut chunks = 0usize;
            while let Ok(Some(f)) = theirs.recv().await {
                if f.kind == RecordType::Chunk {
                    chunks += 1;
                    if chunks == chunk_count {
                        break;
                    }
                }
            }
            chunks
        });
        let r = send_transfer(&mut mine, &manifest, &[Some(p)], &[], |_| {}).await;
        drop(mine);
        let chunks = peer.await.unwrap();
        assert_eq!(chunks, 0, "no chunk may go out");
        match r {
            Err(CoreError::Transfer(text)) => {
                assert_eq!(text, "the source file changed during the send")
            }
            other => panic!("got {other:?}"),
        }
    }

    /// A zero-byte file has the size 0 in the manifest and on disk. It sends.
    #[tokio::test]
    async fn a_zero_byte_file_still_sends() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("empty.bin");
        std::fs::write(&p, b"").unwrap();
        let item = Item::from_file(0, &p, 64 * 1024).unwrap();
        let manifest = Manifest::new(PayloadKind::Media, sender(), vec![item]);
        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let id = manifest.payload_id;
        let peer = tokio::spawn(async move {
            let first = theirs.recv().await.unwrap().unwrap();
            assert_eq!(first.kind, RecordType::Manifest);
            let ack = AckMsg {
                transfer_id: id,
                item_index: 0,
                complete: true,
                hash_ok: true,
            };
            theirs
                .send(
                    CONTROL_STREAM,
                    RecordType::Ack,
                    Bytes::from(ack.to_cbor().unwrap()),
                )
                .await
                .unwrap();
        });
        send_transfer(&mut mine, &manifest, &[Some(p)], &[], |_| {})
            .await
            .unwrap();
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn sends_manifest_then_chunks_then_awaits_ack() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.bin");
        std::fs::write(&p, vec![5u8; 150_000]).unwrap();

        let item = Item::from_file(0, &p, 64 * 1024).unwrap();
        let manifest = Manifest::new(PayloadKind::Media, sender(), vec![item]);

        let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
        let expected_len = std::fs::metadata(&p).unwrap().len();
        let send_manifest = manifest.clone();

        let server = tokio::spawn(async move {
            let (mut conn, _) = tcp::accept(&listener).await.unwrap();
            let mf = conn.recv().await.unwrap().unwrap();
            assert_eq!(mf.kind, RecordType::Manifest);
            let received = Manifest::from_cbor(&mf.body).unwrap();
            assert_eq!(received.items[0].size, Some(expected_len));

            let expected_chunks = received.items[0].chunk_count.unwrap();
            let mut total = 0u64;
            for _ in 0..expected_chunks {
                let f = conn.recv().await.unwrap().unwrap();
                assert_eq!(f.kind, RecordType::Chunk);
                let (idx, _ci, data) = decode_chunk_body(&f.body).unwrap();
                assert_eq!(idx, 0);
                total += data.len() as u64;
            }
            assert_eq!(total, expected_len);
            assert_eq!(expected_chunks, 3);
            let ack = AckMsg {
                transfer_id: send_manifest.payload_id,
                item_index: 0,
                complete: true,
                hash_ok: true,
            };
            conn.send(
                crate::net::CONTROL_STREAM,
                RecordType::Ack,
                bytes::Bytes::from(ack.to_cbor().unwrap()),
            )
            .await
            .unwrap();
        });

        let mut conn = tcp::dial(addr).await.unwrap();
        let paths = vec![Some(p.clone())];
        send_transfer(&mut conn, &manifest, &paths, &[], |_| {})
            .await
            .unwrap();
        server.await.unwrap();
    }

    /// B4: a hash-mismatch ack is NOT a transport failure. The receiver holds
    /// the item in quarantine and says so; the sender must be able to tell the
    /// two apart without parsing an error STRING, because `drain_outbox_row`
    /// routes on exactly that distinction (retry vs. record a quarantine).
    #[tokio::test]
    async fn a_hash_mismatch_ack_is_a_quarantine_naming_the_item() {
        let (r, manifest) = send_to_ack(move |id| AckMsg {
            transfer_id: id,
            item_index: 0,
            complete: true,
            hash_ok: false,
        })
        .await;
        match r {
            Err(CoreError::Quarantined {
                transfer_id,
                item_index,
            }) => {
                assert_eq!(transfer_id, manifest.payload_id);
                assert_eq!(item_index, 0, "the ack names the failed item");
            }
            other => panic!("a hash mismatch must be a Quarantined error, got {other:?}"),
        }
    }

    /// ...and a clean ack is still Ok. Guards the fail-closed direction: the
    /// new error must not swallow a good delivery.
    #[tokio::test]
    async fn a_good_ack_is_still_ok() {
        let (r, _manifest) = send_to_ack(move |id| AckMsg {
            transfer_id: id,
            item_index: 0,
            complete: true,
            hash_ok: true,
        })
        .await;
        r.unwrap_or_else(|e| panic!("a clean ack must not fail, got {e:?}"));
    }

    /// B4 fail-closed: a connection that closes BEFORE the ack is a genuine
    /// transport failure and must keep its existing error, so the retry path
    /// still sees something it is allowed to retry.
    #[tokio::test]
    async fn a_close_before_ack_is_still_a_protocol_error_not_a_quarantine() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.bin");
        std::fs::write(&p, vec![5u8; 2_000]).unwrap();
        let item = Item::from_file(0, &p, 64 * 1024).unwrap();
        let manifest = Manifest::new(PayloadKind::Media, sender(), vec![item]);

        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let peer = tokio::spawn(async move {
            // Read the manifest, then hang up without an ack.
            let _ = theirs.recv().await;
        });
        let r = send_transfer(&mut mine, &manifest, &[Some(p)], &[], |_| {}).await;
        peer.await.unwrap();
        assert!(
            matches!(r, Err(CoreError::Protocol(_))),
            "a close before the ack is a retryable transport error, got {r:?}"
        );
    }

    // Pipeline tests. They call `stream_and_await_ack_with` directly, so the
    // peer gets no manifest frame and send number 1 is chunk number 1.

    use crate::transfer::test_transport::TestTransport;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Source files on disk and the manifest for them.
    struct Source {
        dir: tempfile::TempDir,
        manifest: Manifest,
        paths: Vec<Option<PathBuf>>,
    }

    /// Make one file for each entry of `counts`. File `i` has `counts[i]`
    /// chunks of `CHUNK_SIZE_MIN`. Its last chunk is 7 bytes short.
    fn source(counts: &[u64]) -> Source {
        let dir = tempfile::tempdir().unwrap();
        let mut items = Vec::new();
        let mut paths = Vec::new();
        for (i, count) in counts.iter().enumerate() {
            let p = dir.path().join(format!("f{i}.bin"));
            let size = (*count * CHUNK_SIZE_MIN as u64 - 7) as usize;
            std::fs::write(&p, vec![i as u8 + 1; size]).unwrap();
            let item = Item::from_file(i as u32, &p, CHUNK_SIZE_MIN).unwrap();
            assert_eq!(item.chunk_count, Some(*count));
            items.push(item);
            paths.push(Some(p));
        }
        let manifest = Manifest::new(PayloadKind::Media, sender(), items);
        Source {
            dir,
            manifest,
            paths,
        }
    }

    /// A peer that records each chunk as `(item, chunk)`. After `ack_after`
    /// chunks it sends a complete ack. It reads until the sender closes.
    fn spawn_peer(
        mut theirs: impl FrameTransport + Send + 'static,
        id: [u8; 16],
        ack_after: Option<usize>,
    ) -> tokio::task::JoinHandle<Vec<(u32, u64)>> {
        tokio::spawn(async move {
            let mut chunks = Vec::new();
            while let Ok(Some(f)) = theirs.recv().await {
                if f.kind != RecordType::Chunk {
                    continue;
                }
                let (item, chunk, _) = decode_chunk_body(&f.body).unwrap();
                chunks.push((item, chunk));
                if Some(chunks.len()) == ack_after {
                    let ack = AckMsg {
                        transfer_id: id,
                        item_index: 0,
                        complete: true,
                        hash_ok: true,
                    };
                    theirs
                        .send(
                            CONTROL_STREAM,
                            RecordType::Ack,
                            Bytes::from(ack.to_cbor().unwrap()),
                        )
                        .await
                        .unwrap();
                }
            }
            chunks
        })
    }

    /// A read hook that counts its calls. The test keeps one clone of the
    /// counter. When the reader task ends, it drops the hook and its clone.
    fn counting_hook(count: &Arc<AtomicUsize>) -> impl Fn() + Send + Sync + 'static {
        let count = count.clone();
        move || {
            count.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn sender_frame_order_matches_interleave() {
        let src = source(&[3, 1, 2]);
        let expected = interleave(
            src.manifest
                .items
                .iter()
                .map(|item| ScheduledItem {
                    index: item.index,
                    path: PathBuf::new(),
                    chunk_size: CHUNK_SIZE_MIN,
                    chunk_count: item.chunk_count.unwrap(),
                })
                .collect(),
            1,
        );
        let (mine, theirs) = SecureConnection::<MemConn>::test_pair();
        let peer = spawn_peer(theirs, src.manifest.payload_id, Some(expected.len()));
        let mut conn = TestTransport::new(mine);
        let r = stream_and_await_ack_with(&mut conn, &src.manifest, &src.paths, &[], |_| {}, || {})
            .await;
        drop(conn);
        r.unwrap();
        assert_eq!(peer.await.unwrap(), expected);
    }

    #[tokio::test]
    async fn sender_source_change_fails_and_reader_ends() {
        let src = source(&[4]);
        let p = src.paths[0].clone().unwrap();
        let spare = src.dir.path().join("spare.bin");
        std::fs::copy(&p, &spare).unwrap();
        // Before read 2, a file with the same size and a new inode replaces
        // the source.
        let count = Arc::new(AtomicUsize::new(0));
        let hook = {
            let count = count.clone();
            move || {
                if count.fetch_add(1, Ordering::SeqCst) + 1 == 2 {
                    std::fs::rename(&spare, &p).unwrap();
                }
            }
        };
        let (mine, theirs) = SecureConnection::<MemConn>::test_pair();
        let peer = spawn_peer(theirs, src.manifest.payload_id, None);
        let mut conn = TestTransport::new(mine);
        let r = stream_and_await_ack_with(&mut conn, &src.manifest, &src.paths, &[], |_| {}, hook)
            .await;
        assert_eq!(Arc::strong_count(&count), 1, "the reader task ended");
        drop(conn);
        match r {
            Err(CoreError::Transfer(text)) => {
                assert_eq!(text, "the source file changed during the send")
            }
            other => panic!("got {other:?}"),
        }
        assert_eq!(peer.await.unwrap(), vec![(0, 0)]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sender_symlink_swap_between_chunks_fails() {
        let src = source(&[4]);
        let p = src.paths[0].clone().unwrap();
        let target = src.dir.path().join("target.bin");
        std::fs::copy(&p, &target).unwrap();
        // Before read 2, a symlink to a copy replaces the source.
        let count = Arc::new(AtomicUsize::new(0));
        let hook = {
            let count = count.clone();
            let p = p.clone();
            move || {
                if count.fetch_add(1, Ordering::SeqCst) + 1 == 2 {
                    std::fs::remove_file(&p).unwrap();
                    std::os::unix::fs::symlink(&target, &p).unwrap();
                }
            }
        };
        let (mine, theirs) = SecureConnection::<MemConn>::test_pair();
        let peer = spawn_peer(theirs, src.manifest.payload_id, None);
        let mut conn = TestTransport::new(mine);
        let r = stream_and_await_ack_with(&mut conn, &src.manifest, &src.paths, &[], |_| {}, hook)
            .await;
        assert_eq!(Arc::strong_count(&count), 1, "the reader task ended");
        drop(conn);
        let e = r.expect_err("a symlink swap must fail the send");
        let dir = src.dir.path().to_string_lossy().into_owned();
        assert!(!e.to_string().contains(&dir), "the error holds a path: {e}");
        assert_eq!(
            peer.await.unwrap(),
            vec![(0, 0)],
            "no chunk goes out after the read error"
        );
    }

    #[tokio::test]
    async fn sender_early_stop_ends_reader() {
        let src = source(&[6]);
        let count = Arc::new(AtomicUsize::new(0));
        let (mine, theirs) = SecureConnection::<MemConn>::test_pair();
        let peer = spawn_peer(theirs, src.manifest.payload_id, None);
        let mut conn = TestTransport::new(mine).fail_send_at(3);
        let r = stream_and_await_ack_with(
            &mut conn,
            &src.manifest,
            &src.paths,
            &[],
            |_| {},
            counting_hook(&count),
        )
        .await;
        assert_eq!(Arc::strong_count(&count), 1, "the reader task ended");
        drop(conn);
        match r {
            Err(CoreError::Protocol(text)) => assert_eq!(text, "test transport: send failed"),
            other => panic!("got {other:?}"),
        }
        assert_eq!(peer.await.unwrap(), vec![(0, 0), (0, 1)]);
    }

    #[tokio::test]
    async fn sender_reader_runs_at_most_read_ahead_plus_2() {
        let src = source(&[10]);
        let count = Arc::new(AtomicUsize::new(0));
        let (mine, theirs) = SecureConnection::<MemConn>::test_pair();
        let peer = spawn_peer(theirs, src.manifest.payload_id, None);
        // The gate never opens, so the first chunk send blocks.
        let mut conn = TestTransport::new(mine).block_until(Arc::new(tokio::sync::Notify::new()));
        let bound = READ_AHEAD + 2;
        {
            let run = stream_and_await_ack_with(
                &mut conn,
                &src.manifest,
                &src.paths,
                &[],
                |_| {},
                counting_hook(&count),
            );
            tokio::pin!(run);
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            while count.load(Ordering::SeqCst) < bound && tokio::time::Instant::now() < deadline {
                tokio::select! {
                    r = &mut run => panic!("the send must block, got {r:?}"),
                    _ = tokio::time::sleep(Duration::from_millis(10)) => {}
                }
            }
            // Give the reader time to read too far, if it can.
            tokio::select! {
                r = &mut run => panic!("the send must block, got {r:?}"),
                _ = tokio::time::sleep(Duration::from_millis(200)) => {}
            }
            assert_eq!(count.load(Ordering::SeqCst), bound);
        }
        // The drop of the send future closes the channel. The reader then ends.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while Arc::strong_count(&count) > 1 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(Arc::strong_count(&count), 1, "the reader task ended");
        drop(conn);
        assert!(peer.await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn sender_progress_runs_after_send() {
        let src = source(&[3, 2]);
        let total: u64 = src.manifest.items.iter().map(|i| i.size.unwrap()).sum();
        let (mine, theirs) = SecureConnection::<MemConn>::test_pair();
        let peer = spawn_peer(theirs, src.manifest.payload_id, Some(5));
        let mut conn = TestTransport::new(mine);
        let done = conn.completed_sends();
        // Each entry is (sends completed at the call, bytes of the call).
        let mut progress = Vec::new();
        let r = stream_and_await_ack_with(
            &mut conn,
            &src.manifest,
            &src.paths,
            &[],
            |n| progress.push((done.load(Ordering::SeqCst), n)),
            || {},
        )
        .await;
        drop(conn);
        r.unwrap();
        assert_eq!(peer.await.unwrap().len(), 5);
        let seen: Vec<usize> = progress.iter().map(|(d, _)| *d).collect();
        assert_eq!(seen, vec![1, 2, 3, 4, 5], "progress k runs after send k");
        assert_eq!(progress.iter().map(|(_, n)| n).sum::<u64>(), total);
    }

    /// A truncate after the file id check and before `read_exact` gives a
    /// short read. The read hook cannot make this case, because the hook runs
    /// before the open and the id check. So this test gives `read_at` a
    /// reader that is shorter than the chunk.
    #[test]
    fn sender_truncate_during_read_gives_changed_error() {
        let original = [1u8; 100];
        let mut short = std::io::Cursor::new(original[..70].to_vec());
        match read_at(&mut short, 50, 50) {
            Err(CoreError::Transfer(text)) => {
                assert_eq!(text, "the source file changed during the send")
            }
            other => panic!("got {other:?}"),
        }
        // The read of the bytes that are still there gives the original bytes.
        assert_eq!(read_at(&mut short, 0, 70).unwrap(), original[..70]);
    }

    #[tokio::test]
    async fn sender_overlap() {
        const CHUNKS: u64 = 40;
        const STEP: Duration = Duration::from_millis(20);
        let src = source(&[CHUNKS]);
        // A plain `MemConn` pair: no Noise layer. In a debug build the encrypt
        // and the decrypt of a 64 KiB chunk cost several ms on the same
        // thread. The 40 x 40 ms model does not count that cost.
        let (mine, theirs) = MemConn::pair();
        let peer = spawn_peer(theirs, src.manifest.payload_id, Some(CHUNKS as usize));
        let mut conn = TestTransport::new(mine).with_send_delay(STEP);
        // Measure the real hook sleeps. On macOS a sleep of 20 ms lasts up to
        // 25 ms. The sequential time is 2 x the measured sum, not the
        // nominal 40 x 40 ms. The send delay has the same nominal step.
        let slept = std::sync::Arc::new(std::sync::Mutex::new(Duration::ZERO));
        let hook = {
            let slept = slept.clone();
            move || {
                let t = std::time::Instant::now();
                std::thread::sleep(STEP);
                *slept.lock().unwrap() += t.elapsed();
            }
        };
        let start = std::time::Instant::now();
        let r = stream_and_await_ack_with(&mut conn, &src.manifest, &src.paths, &[], |_| {}, hook)
            .await;
        let elapsed = start.elapsed();
        drop(conn);
        r.unwrap();
        assert_eq!(peer.await.unwrap().len(), CHUNKS as usize);
        let sequential = (*slept.lock().unwrap() * 2).max(STEP * 2 * CHUNKS as u32);
        eprintln!("sender_overlap: loop {elapsed:?}, sequential {sequential:?}");
        assert!(
            elapsed < sequential * 3 / 4,
            "took {elapsed:?}; a sequential run takes about {sequential:?}"
        );
    }
}
