use std::path::{Path, PathBuf};

use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use crate::chunk::ChunkBitmap;
use crate::control::AckMsg;
use crate::error::{ensure_compatible, CoreError, Result};
use crate::framing::RecordType;
use crate::hash::blake2b256_reader;
use crate::manifest::{Item, Manifest, CHUNK_SIZE_MAX, CHUNK_SIZE_MIN};
use crate::net::{FrameTransport, CONTROL_STREAM};
use crate::store::Db;

use super::sender::decode_chunk_body;

const MAX_ITEM_CHUNKS: u64 = 1 << 24;
const MAX_ITEMS: usize = 65536;
const MAX_TOTAL_CHUNKS: u64 = 1 << 27;
const BITMAP_PERSIST_INTERVAL: u64 = 256;

fn safe_item_name(item: &Item) -> String {
    let raw = item.name.as_deref().unwrap_or("");
    match Path::new(raw).file_name().and_then(|n| n.to_str()) {
        Some(n) if !n.is_empty() && n != "." && n != ".." => n.to_owned(),
        _ => format!("item_{}", item.index),
    }
}

fn item_output_path(out_dir: &Path, item: &Item) -> Result<PathBuf> {
    let path = out_dir.join(safe_item_name(item));
    if path.parent() != Some(out_dir) {
        return Err(CoreError::Protocol(format!(
            "item {} name escapes output directory",
            item.index
        )));
    }
    Ok(path)
}

fn validate_manifest(manifest: &Manifest) -> Result<()> {
    if manifest.items.len() > MAX_ITEMS {
        return Err(CoreError::Protocol(format!(
            "manifest has {} items exceeds cap {MAX_ITEMS}",
            manifest.items.len()
        )));
    }
    ensure_compatible(manifest.v)?;
    for (pos, item) in manifest.items.iter().enumerate() {
        if item.index as usize != pos {
            return Err(CoreError::Protocol(format!(
                "manifest item at position {pos} declares index {}",
                item.index
            )));
        }
    }
    Ok(())
}

pub async fn receive_transfer<T: FrameTransport>(
    conn: &mut T,
    out_dir: &Path,
    mut on_progress: impl FnMut(u64),
    db: Option<&Db>,
) -> Result<Manifest> {
    let manifest = loop {
        match conn.recv().await? {
            Some(f) if f.kind == RecordType::Manifest => break Manifest::from_cbor(&f.body)?,
            Some(_) => continue,
            None => return Err(CoreError::Protocol("closed before manifest".into())),
        }
    };

    validate_manifest(&manifest)?;

    tokio::fs::create_dir_all(out_dir).await?;
    let capacity = manifest.items.len().min(MAX_ITEMS);
    let mut files: Vec<Option<tokio::fs::File>> = Vec::with_capacity(capacity);
    let mut bitmaps: Vec<Option<ChunkBitmap>> = Vec::with_capacity(capacity);
    let mut total_chunks: u64 = 0;
    for item in &manifest.items {
        if !item.is_binary() {
            files.push(None);
            bitmaps.push(None);
            continue;
        }
        let size = item.size.ok_or_else(|| {
            CoreError::Protocol(format!("binary item {} missing size", item.index))
        })?;
        let chunk_size = item.chunk_size.ok_or_else(|| {
            CoreError::Protocol(format!("binary item {} missing chunk_size", item.index))
        })?;
        let chunk_count = item.chunk_count.ok_or_else(|| {
            CoreError::Protocol(format!("binary item {} missing chunk_count", item.index))
        })?;
        if !(CHUNK_SIZE_MIN..=CHUNK_SIZE_MAX).contains(&chunk_size) {
            return Err(CoreError::Protocol(format!(
                "binary item {} chunk_size {chunk_size} outside allowed range {CHUNK_SIZE_MIN}..={CHUNK_SIZE_MAX}",
                item.index
            )));
        }
        let expected = size.div_ceil(chunk_size as u64);
        if chunk_count != expected {
            return Err(CoreError::Protocol(format!(
                "binary item {} chunk_count {chunk_count} does not match size {size} / chunk_size {chunk_size} ({expected})",
                item.index
            )));
        }
        if chunk_count > MAX_ITEM_CHUNKS {
            return Err(CoreError::Protocol(format!(
                "binary item {} chunk_count {chunk_count} exceeds cap {MAX_ITEM_CHUNKS}",
                item.index
            )));
        }
        total_chunks = total_chunks
            .checked_add(chunk_count)
            .ok_or_else(|| CoreError::Protocol("total chunk count overflow".into()))?;
        if total_chunks > MAX_TOTAL_CHUNKS {
            return Err(CoreError::Protocol(format!(
                "manifest chunks exceed total cap {MAX_TOTAL_CHUNKS}"
            )));
        }
        let path = item_output_path(out_dir, item)?;
        // Open without truncating: a resumed receive must preserve already-written
        // partial chunks so the persisted bitmap still points at real on-disk data.
        let f = tokio::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .await?;
        files.push(Some(f));
        bitmaps.push(Some(ChunkBitmap::new(chunk_count)));
    }

    let all_received = |bitmaps: &[Option<ChunkBitmap>]| {
        bitmaps
            .iter()
            .all(|b| b.as_ref().map(|b| b.is_complete()).unwrap_or(true))
    };

    let mut received_any = false;
    // ponytail: one counter shared across all items; an item completed well
    // before a later hard-kill persists only on graceful early-close. Re-fetch is
    // idempotent and the per-item BLAKE2b hash is the final authority, so this is
    // an efficiency ceiling, not a correctness gap.
    let mut chunks_since_persist: u64 = 0;

    while !all_received(&bitmaps) {
        let frame = match conn.recv().await? {
            Some(f) => f,
            None => {
                if let Some(db) = db {
                    if received_any {
                        for (i, bm) in bitmaps.iter().enumerate() {
                            if let Some(bm) = bm {
                                // R-T7-5: keyed by manifest.payload_id, never a
                                // transfer id -- the resuming peer must find these.
                                db.save_bitmap(&manifest.payload_id, i as u32, bm)?;
                            }
                        }
                    }
                    return Err(CoreError::TransferInterrupted);
                }
                return Err(CoreError::Protocol("closed mid-transfer".into()));
            }
        };
        if frame.kind != RecordType::Chunk {
            continue;
        }
        let (item_index, chunk_index, data) = decode_chunk_body(&frame.body)?;
        let idx = item_index as usize;
        let chunk_size = manifest
            .items
            .get(idx)
            .and_then(|i| i.chunk_size)
            .ok_or_else(|| CoreError::Protocol(format!("chunk for unknown item {item_index}")))?;
        let chunk_count = manifest.items[idx]
            .chunk_count
            .ok_or_else(|| CoreError::Protocol(format!("item {item_index} missing chunk_count")))?;
        if chunk_index >= chunk_count {
            return Err(CoreError::Protocol(format!(
                "chunk index {chunk_index} out of range for item {item_index}"
            )));
        }
        let offset = (chunk_size as u64)
            .checked_mul(chunk_index)
            .ok_or_else(|| {
                CoreError::Protocol(format!("chunk index {chunk_index} overflows file offset"))
            })?;
        offset.checked_add(data.len() as u64).ok_or_else(|| {
            CoreError::Protocol(format!("chunk for item {item_index} overflows file size"))
        })?;

        let file = files
            .get_mut(idx)
            .and_then(|f| f.as_mut())
            .ok_or_else(|| CoreError::Protocol(format!("chunk for unknown item {item_index}")))?;
        file.seek(std::io::SeekFrom::Start(offset)).await?;
        file.write_all(&data).await?;
        on_progress(data.len() as u64);
        let bitmap = bitmaps[idx].as_mut().ok_or_else(|| {
            CoreError::Protocol(format!("chunk for non-binary item {item_index}"))
        })?;
        if !bitmap.set(chunk_index) {
            return Err(CoreError::Protocol(format!(
                "chunk index {chunk_index} out of range for item {item_index}"
            )));
        }
        if let Some(db) = db {
            received_any = true;
            chunks_since_persist += 1;
            if chunks_since_persist >= BITMAP_PERSIST_INTERVAL {
                // R-T7-5: keyed by manifest.payload_id (see above).
                db.save_bitmap(&manifest.payload_id, item_index, bitmap)?;
                chunks_since_persist = 0;
            }
        }
    }

    for f in files.iter_mut().flatten() {
        f.flush().await?;
    }
    drop(files);

    // R-T7-3/R-T7-5: the receive is done, so no NACK can follow. Drop the resume
    // rows (keyed by payload_id, the inbound resume key) instead of leaving
    // stale chunk_state behind.
    if let Some(db) = db {
        for (i, bm) in bitmaps.iter().enumerate() {
            if bm.is_some() {
                db.clear_bitmap(&manifest.payload_id, i as u32)?;
            }
        }
    }

    let mut hash_ok = true;
    let mut failed_item = 0u32;
    for item in manifest.binary_items() {
        let path = item_output_path(out_dir, item)?;
        let f = std::fs::File::open(&path)?;
        let actual = blake2b256_reader(f)?;
        if Some(actual) != item.hash {
            hash_ok = false;
            failed_item = item.index;
            break;
        }
    }

    let ack = AckMsg {
        transfer_id: manifest.payload_id,
        item_index: failed_item,
        complete: true,
        hash_ok,
    };
    conn.send(
        CONTROL_STREAM,
        RecordType::Ack,
        bytes::Bytes::from(ack.to_cbor()?),
    )
    .await?;

    if !hash_ok {
        if let Some(item) = manifest.items.iter().find(|i| i.index == failed_item) {
            let good = item_output_path(out_dir, item)?;
            let quarantine = out_dir.join(format!("{}.quarantine", safe_item_name(item)));
            let _ = tokio::fs::rename(&good, &quarantine).await;
        }
        return Err(CoreError::Transfer(format!(
            "hash mismatch on item {failed_item}"
        )));
    }
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::framing::RecordType;
    use crate::manifest::{DeviceRef, Item, ItemType, PayloadKind};
    use crate::net::tcp;
    use crate::net::CONTROL_STREAM;
    use crate::transfer::encode_chunk_body;
    use bytes::Bytes;

    fn dev() -> DeviceRef {
        DeviceRef {
            device_id: [7u8; 16],
            name: "s".into(),
        }
    }

    async fn receive_manifest_only(manifest: Manifest, out: &std::path::Path) -> Result<Manifest> {
        let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
        let m = manifest.clone();
        let sender = tokio::spawn(async move {
            let (mut conn, _) = tcp::accept(&listener).await.unwrap();
            conn.send(
                CONTROL_STREAM,
                RecordType::Manifest,
                Bytes::from(m.to_cbor().unwrap()),
            )
            .await
            .unwrap();
        });
        let mut conn = tcp::dial(addr).await.unwrap();
        let res = receive_transfer(&mut conn, out, |_| {}, None).await;
        sender.await.unwrap();
        res
    }

    #[tokio::test]
    async fn receives_chunks_verifies_hash_and_writes_file() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let path = src.path().join("movie.bin");
        let payload: Vec<u8> = (0..250_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &payload).unwrap();

        let item = Item::from_file(0, &path, 64 * 1024).unwrap();
        let manifest = Manifest::new(PayloadKind::Media, dev(), vec![item]);

        let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
        let sender_manifest = manifest.clone();
        let sender = tokio::spawn(async move {
            let (mut conn, _) = tcp::accept(&listener).await.unwrap();
            crate::transfer::send_transfer(
                &mut conn,
                &sender_manifest,
                &[Some(path.clone())],
                &[],
                |_| {},
            )
            .await
            .unwrap();
        });

        let mut conn = tcp::dial(addr).await.unwrap();
        let got = receive_transfer(&mut conn, dst.path(), |_| {}, None)
            .await
            .unwrap();
        sender.await.unwrap();

        assert_eq!(got.payload_id, manifest.payload_id);
        let written = dst.path().join("movie.bin");
        assert_eq!(std::fs::read(&written).unwrap(), payload);
    }

    #[tokio::test]
    async fn detects_corrupted_chunk_and_reports_hash_failure() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let path = src.path().join("t.bin");
        std::fs::write(&path, vec![3u8; 100_000]).unwrap();

        let mut item = Item::from_file(0, &path, 64 * 1024).unwrap();
        item.hash = Some([0u8; 32]); // deliberately wrong
        let manifest = Manifest::new(PayloadKind::Media, dev(), vec![item]);

        let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
        let m = manifest.clone();
        let sender = tokio::spawn(async move {
            let (mut conn, _) = tcp::accept(&listener).await.unwrap();
            // The receiver will ack with hash_ok=false, so the sender is expected to fail.
            let _ =
                crate::transfer::send_transfer(&mut conn, &m, &[Some(path.clone())], &[], |_| {})
                    .await;
        });

        let mut conn = tcp::dial(addr).await.unwrap();
        let res = receive_transfer(&mut conn, dst.path(), |_| {}, None).await;
        sender.await.unwrap();
        assert!(matches!(res, Err(crate::CoreError::Transfer(_))));
        assert!(
            !dst.path().join("t.bin").exists(),
            "corrupt file must not remain at final path"
        );
        assert!(
            dst.path().join("t.bin.quarantine").exists(),
            "corrupt file must be quarantined"
        );
    }

    #[tokio::test]
    async fn rejects_out_of_range_chunk_index_with_protocol_error() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let path = src.path().join("r.bin");
        std::fs::write(&path, vec![9u8; 100_000]).unwrap();

        let item = Item::from_file(0, &path, 64 * 1024).unwrap();
        let manifest = Manifest::new(PayloadKind::Media, dev(), vec![item]);

        let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
        let m = manifest.clone();
        let sender = tokio::spawn(async move {
            let (mut conn, _) = tcp::accept(&listener).await.unwrap();
            conn.send(
                CONTROL_STREAM,
                RecordType::Manifest,
                Bytes::from(m.to_cbor().unwrap()),
            )
            .await
            .unwrap();
            let body = encode_chunk_body(0, 999, b"bogus");
            conn.send(100, RecordType::Chunk, Bytes::from(body))
                .await
                .unwrap();
        });

        let mut conn = tcp::dial(addr).await.unwrap();
        let res = receive_transfer(&mut conn, dst.path(), |_| {}, None).await;
        sender.await.unwrap();
        assert!(matches!(res, Err(crate::CoreError::Protocol(_))));
    }

    #[tokio::test]
    async fn rejects_overflowing_chunk_index_without_writing() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let path = src.path().join("o.bin");
        std::fs::write(&path, vec![4u8; 100_000]).unwrap();

        let item = Item::from_file(0, &path, 64 * 1024).unwrap();
        let manifest = Manifest::new(PayloadKind::Media, dev(), vec![item]);

        let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
        let m = manifest.clone();
        let sender = tokio::spawn(async move {
            let (mut conn, _) = tcp::accept(&listener).await.unwrap();
            conn.send(
                CONTROL_STREAM,
                RecordType::Manifest,
                Bytes::from(m.to_cbor().unwrap()),
            )
            .await
            .unwrap();
            let body = encode_chunk_body(0, u64::MAX, b"x");
            conn.send(100, RecordType::Chunk, Bytes::from(body))
                .await
                .unwrap();
        });

        let mut conn = tcp::dial(addr).await.unwrap();
        let res = receive_transfer(&mut conn, dst.path(), |_| {}, None).await;
        sender.await.unwrap();
        assert!(matches!(res, Err(crate::CoreError::Protocol(_))));
        let written = dst.path().join("o.bin");
        assert_eq!(
            std::fs::metadata(&written).map(|m| m.len()).unwrap_or(0),
            0,
            "no bytes may be written for an out-of-range chunk"
        );
    }

    #[tokio::test]
    async fn sanitizes_traversal_item_name_into_out_dir() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let path = src.path().join("movie.bin");
        let payload: Vec<u8> = (0..130_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &payload).unwrap();

        let mut item = Item::from_file(0, &path, 64 * 1024).unwrap();
        item.name = Some("../evil.txt".into());
        let manifest = Manifest::new(PayloadKind::Media, dev(), vec![item]);

        let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
        let sender_manifest = manifest.clone();
        let sender = tokio::spawn(async move {
            let (mut conn, _) = tcp::accept(&listener).await.unwrap();
            crate::transfer::send_transfer(
                &mut conn,
                &sender_manifest,
                &[Some(path.clone())],
                &[],
                |_| {},
            )
            .await
            .unwrap();
        });

        let mut conn = tcp::dial(addr).await.unwrap();
        receive_transfer(&mut conn, dst.path(), |_| {}, None)
            .await
            .unwrap();
        sender.await.unwrap();

        assert_eq!(
            std::fs::read(dst.path().join("evil.txt")).unwrap(),
            payload,
            "traversal name must be neutralized to its final component"
        );
        let escaped = dst.path().parent().unwrap().join("evil.txt");
        assert!(!escaped.exists(), "traversal name must not escape out_dir");
    }

    #[tokio::test]
    async fn rejects_binary_item_missing_chunk_count() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let path = src.path().join("m.bin");
        std::fs::write(&path, vec![1u8; 100_000]).unwrap();

        let mut item = Item::from_file(0, &path, 64 * 1024).unwrap();
        item.chunk_count = None;
        let manifest = Manifest::new(PayloadKind::Media, dev(), vec![item]);

        let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
        let m = manifest.clone();
        let sender = tokio::spawn(async move {
            let (mut conn, _) = tcp::accept(&listener).await.unwrap();
            conn.send(
                CONTROL_STREAM,
                RecordType::Manifest,
                Bytes::from(m.to_cbor().unwrap()),
            )
            .await
            .unwrap();
        });

        let mut conn = tcp::dial(addr).await.unwrap();
        let res = receive_transfer(&mut conn, dst.path(), |_| {}, None).await;
        sender.await.unwrap();
        assert!(matches!(res, Err(crate::CoreError::Protocol(_))));
    }

    #[tokio::test]
    async fn rejects_enormous_size_with_chunk_count_over_cap() {
        let dst = tempfile::tempdir().unwrap();
        let size = u64::MAX / 2;
        let chunk_size = CHUNK_SIZE_MIN;
        let item = Item {
            item_type: ItemType::Document,
            name: Some("huge.bin".into()),
            size: Some(size),
            chunk_size: Some(chunk_size),
            chunk_count: Some(size.div_ceil(chunk_size as u64)),
            ..Default::default()
        };
        let manifest = Manifest::new(PayloadKind::Media, dev(), vec![item]);

        let res = receive_manifest_only(manifest, dst.path()).await;
        assert!(matches!(res, Err(crate::CoreError::Protocol(_))));
    }

    #[tokio::test]
    async fn rejects_chunk_size_below_min() {
        let dst = tempfile::tempdir().unwrap();
        let item = Item {
            item_type: ItemType::Document,
            name: Some("small.bin".into()),
            size: Some(1000),
            chunk_size: Some(CHUNK_SIZE_MIN - 1),
            chunk_count: Some(1),
            ..Default::default()
        };
        let manifest = Manifest::new(PayloadKind::Media, dev(), vec![item]);

        let res = receive_manifest_only(manifest, dst.path()).await;
        assert!(matches!(res, Err(crate::CoreError::Protocol(_))));
    }

    #[tokio::test]
    async fn rejects_chunk_size_above_max() {
        let dst = tempfile::tempdir().unwrap();
        let item = Item {
            item_type: ItemType::Document,
            name: Some("big.bin".into()),
            size: Some(1000),
            chunk_size: Some(CHUNK_SIZE_MAX + 1),
            chunk_count: Some(1),
            ..Default::default()
        };
        let manifest = Manifest::new(PayloadKind::Media, dev(), vec![item]);

        let res = receive_manifest_only(manifest, dst.path()).await;
        assert!(matches!(res, Err(crate::CoreError::Protocol(_))));
    }

    #[tokio::test]
    async fn rejects_total_chunks_over_cap() {
        let dst = tempfile::tempdir().unwrap();
        let chunk_size = CHUNK_SIZE_MIN;
        let size = MAX_ITEM_CHUNKS * chunk_size as u64;
        let count = MAX_TOTAL_CHUNKS / MAX_ITEM_CHUNKS + 1;
        let items: Vec<Item> = (0..count)
            .map(|i| Item {
                index: i as u32,
                item_type: ItemType::Document,
                name: Some(format!("item_{i}.bin")),
                size: Some(size),
                chunk_size: Some(chunk_size),
                chunk_count: Some(MAX_ITEM_CHUNKS),
                ..Default::default()
            })
            .collect();
        let manifest = Manifest::new(PayloadKind::Media, dev(), items);

        let res = receive_manifest_only(manifest, dst.path()).await;
        assert!(matches!(res, Err(crate::CoreError::Protocol(_))));
    }

    #[tokio::test]
    async fn rejects_manifest_with_too_many_items() {
        let dst = tempfile::tempdir().unwrap();
        let items: Vec<Item> = (0..MAX_ITEMS + 1)
            .map(|i| Item {
                index: i as u32,
                ..Default::default()
            })
            .collect();
        let manifest = Manifest::new(PayloadKind::Media, dev(), items);

        let res = receive_manifest_only(manifest, dst.path()).await;
        assert!(matches!(res, Err(crate::CoreError::Protocol(_))));
    }

    #[test]
    fn validate_manifest_rejects_misindexed_item() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.bin");
        std::fs::write(&path, vec![1u8; 100]).unwrap();
        let item0 = Item::from_file(0, &path, 64 * 1024).unwrap();
        let mut item1 = Item::from_file(1, &path, 64 * 1024).unwrap();
        item1.index = 7;
        let manifest = Manifest::new(PayloadKind::Media, dev(), vec![item0, item1]);
        assert!(matches!(
            validate_manifest(&manifest),
            Err(CoreError::Protocol(m)) if m.contains("position 1") && m.contains("7")
        ));
    }

    #[test]
    fn validate_manifest_rejects_incompatible_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.bin");
        std::fs::write(&path, vec![1u8; 100]).unwrap();
        let item = Item::from_file(0, &path, 64 * 1024).unwrap();
        let mut manifest = Manifest::new(PayloadKind::Media, dev(), vec![item]);
        manifest.v = crate::manifest::MANIFEST_VERSION + 100;
        assert!(matches!(
            validate_manifest(&manifest),
            Err(CoreError::UnsupportedSchema)
        ));
    }

    #[test]
    fn validate_manifest_accepts_sequential_indices() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.bin");
        std::fs::write(&path, vec![1u8; 100]).unwrap();
        let items = vec![
            Item::from_file(0, &path, 64 * 1024).unwrap(),
            Item::from_file(1, &path, 64 * 1024).unwrap(),
        ];
        let manifest = Manifest::new(PayloadKind::Media, dev(), items);
        validate_manifest(&manifest).unwrap();
    }
}
