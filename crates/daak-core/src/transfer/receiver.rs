use std::path::{Path, PathBuf};

use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use crate::chunk::ChunkBitmap;
use crate::control::AckMsg;
use crate::error::{ensure_compatible, CoreError, Result};
use crate::framing::RecordType;
use crate::hash::blake2b256_reader;
use crate::manifest::{Item, Manifest, CHUNK_SIZE_MAX, CHUNK_SIZE_MIN};
use crate::net::{FrameTransport, CONTROL_STREAM};
use crate::store::transfers::{ItemRow, TransferRow};
use crate::store::Db;

use super::sender::decode_chunk_body;
use super::Quarantine;

const MAX_ITEM_CHUNKS: u64 = 1 << 24;
const MAX_ITEMS: usize = 65536;
const MAX_TOTAL_CHUNKS: u64 = 1 << 27;
const BITMAP_PERSIST_INTERVAL: u64 = 256;

fn safe_item_name(item: &Item) -> String {
    let raw = item.name.as_deref().unwrap_or("");
    match Path::new(raw).file_name().and_then(|n| n.to_str()) {
        // `quarantine` is the reserved quarantine root inside out_dir: a peer
        // naming an item that would turn the directory into a file.
        Some(n) if !n.is_empty() && n != "." && n != ".." && n != "quarantine" => n.to_owned(),
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
    // R-T12-6: with a Db supplied, the inbound transfer becomes a real row so a
    // quarantined item has something to point at and `retry_item` can find it.
    // Db::upsert_transfer's ON CONFLICT branch leaves payload_id/peer/kind/
    // direction alone, so the second (final) upsert is safe.
    if let Some(db) = db {
        let now = crate::manifest::now_ms() as i64 / 1000;
        db.upsert_transfer(&TransferRow {
            transfer_id: manifest.payload_id,
            payload_id: manifest.payload_id,
            peer_device_id: manifest.sender.device_id,
            direction: "in".into(),
            kind: format!("{:?}", manifest.kind).to_lowercase(),
            state: "active".into(),
            bytes_total: manifest.items.iter().filter_map(|i| i.size).sum(),
            bytes_done: 0,
            item_count: manifest.items.len() as u32,
            created_at: now,
            updated_at: now,
            manifest: manifest.to_cbor()?,
            error: None,
        })?;
    }
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

    // R-T12-5: a hash mismatch isolates ONE file, it does not fail the transfer.
    // The per-item loop keeps going so 99 good files survive 1 bad one.
    let quarantine = Quarantine::new(out_dir.join("quarantine"));
    let mut hash_ok = true;
    // C-1: Option, not a u32 sentinel of 0 - item 0 failing used to leave the
    // sentinel unset so the NEXT failure overwrote the reported item.
    let mut failed_item: Option<u32> = None;
    // Every item whose hash DID fail, whether or not the move into quarantine
    // succeeded (I-4): the DB state follows the hash, not the rename.
    let mut failed: Vec<u32> = Vec::new();
    let mut held_paths: Vec<(u32, PathBuf)> = Vec::new();
    for item in manifest.binary_items() {
        let path = item_output_path(out_dir, item)?;
        let f = std::fs::File::open(&path)?;
        let actual = blake2b256_reader(f)?;
        if Some(actual) == item.hash {
            continue;
        }
        hash_ok = false;
        if failed_item.is_none() {
            failed_item = Some(item.index);
        }
        failed.push(item.index);
        if db.is_some() {
            // I-4: a rename failure unrelated to corruption (ENOTDIR,
            // cross-device, read-only out dir) must not take down the whole
            // transfer after every byte already landed.
            match quarantine.hold(&manifest.payload_id, &safe_item_name(item), &path) {
                Ok(held) => held_paths.push((item.index, held)),
                Err(e) => tracing::warn!(
                    item = item.index,
                    error = %e,
                    "quarantine hold failed; item stays at its final path"
                ),
            }
        }
    }

    // R-T12-6: persist the item rows (and the final transfer state) so a
    // quarantined item is reachable by retry_item / the UI.
    if let Some(db) = db {
        let mut bytes_done = 0u64;
        for item in &manifest.items {
            let quarantined = failed.contains(&item.index);
            db.upsert_item(&ItemRow {
                transfer_id: manifest.payload_id,
                item_index: item.index,
                item_type: item.item_type.as_str().to_string(),
                name: item.name.clone(),
                mime: item.mime.clone(),
                size: item.size,
                hash: item.hash,
                // Non-binary items are never materialised, so a dest_path for
                // them would point at a file that can never exist.
                dest_path: if !item.is_binary() {
                    None
                } else {
                    let dest = match held_paths.iter().find(|(i, _)| *i == item.index) {
                        Some((_, p)) => p.clone(),
                        None => item_output_path(out_dir, item)?,
                    };
                    dest.to_str().map(|s| s.to_string())
                },
                state: if quarantined {
                    "quarantined".into()
                } else {
                    "received".into()
                },
            })?;
            if !quarantined {
                bytes_done += item.size.unwrap_or(0);
            }
        }
        db.upsert_transfer(&TransferRow {
            transfer_id: manifest.payload_id,
            payload_id: manifest.payload_id,
            peer_device_id: manifest.sender.device_id,
            direction: "in".into(),
            kind: format!("{:?}", manifest.kind).to_lowercase(),
            state: "done".into(),
            bytes_total: manifest.items.iter().filter_map(|i| i.size).sum(),
            bytes_done,
            item_count: manifest.items.len() as u32,
            created_at: crate::manifest::now_ms() as i64 / 1000,
            updated_at: crate::manifest::now_ms() as i64 / 1000,
            manifest: manifest.to_cbor()?,
            // I-3: bytes_done above deliberately counts only the items that
            // actually landed, so say how many are missing rather than letting
            // a done transfer read as half-delivered.
            error: (!failed.is_empty())
                .then(|| format!("{} item(s) quarantined after hash mismatch", failed.len())),
        })?;
    }

    let ack = AckMsg {
        transfer_id: manifest.payload_id,
        item_index: failed_item.unwrap_or(0),
        complete: true,
        hash_ok,
    };
    conn.send(
        CONTROL_STREAM,
        RecordType::Ack,
        bytes::Bytes::from(ack.to_cbor()?),
    )
    .await?;

    if !hash_ok && db.is_none() {
        // No DB row to report a quarantined item against, so the caller cannot
        // learn WHICH file failed: keep today's whole-transfer failure.
        if let Some(item) = manifest.items.iter().find(|i| Some(i.index) == failed_item) {
            let good = item_output_path(out_dir, item)?;
            let dest = quarantine.slot(&manifest.payload_id, &safe_item_name(item));
            if let Some(dir) = dest.parent() {
                let _ = tokio::fs::create_dir_all(dir).await;
            }
            let _ = tokio::fs::rename(&good, &dest).await;
        }
        return Err(CoreError::Transfer(format!(
            "hash mismatch on item {}",
            failed_item.unwrap_or(0)
        )));
    }
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::framing::RecordType;
    use crate::manifest::{DeviceRef, Item, ItemType, PayloadKind};
    use crate::net::secure::{MemConn, SecureConnection};
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

        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let m = manifest.clone();
        let sender = tokio::spawn(async move {
            // The receiver will ack with hash_ok=false, so the sender is expected to fail.
            let _ =
                crate::transfer::send_transfer(&mut theirs, &m, &[Some(path.clone())], &[], |_| {})
                    .await;
        });

        let res = receive_transfer(&mut mine, dst.path(), |_| {}, None).await;
        sender.await.unwrap();
        assert!(matches!(res, Err(crate::CoreError::Transfer(_))));
        assert!(
            !dst.path().join("t.bin").exists(),
            "corrupt file must not remain at final path"
        );
        // R-T12-5: the layout is <out>/quarantine/<hex payload_id>/<safe name>.
        let held = dst
            .path()
            .join("quarantine")
            .join(hex::encode(manifest.payload_id))
            .join("t.bin");
        assert!(
            held.exists(),
            "corrupt file must be quarantined at {held:?}"
        );
    }

    /// R-T12-5: with a Db, a hash-failed item is ISOLATED and the transfer still
    /// succeeds. One bad file must not cost the user the good one.
    #[tokio::test]
    async fn a_bad_item_is_quarantined_and_the_good_item_still_lands() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let bad = src.path().join("bad.bin");
        let good = src.path().join("good.bin");
        std::fs::write(&bad, vec![1u8; 40_000]).unwrap();
        std::fs::write(&good, vec![2u8; 40_000]).unwrap();

        let mut bad_item = Item::from_file(0, &bad, 64 * 1024).unwrap();
        bad_item.hash = Some([0u8; 32]); // deliberately wrong
        let good_item = Item::from_file(1, &good, 64 * 1024).unwrap();
        let manifest = Manifest::new(PayloadKind::Media, dev(), vec![bad_item, good_item]);

        let db = crate::store::Db::open_in_memory().unwrap();
        db.migrate().unwrap();

        // test_pair, not a TCP bind: this sandbox (and CI) must be able to run
        // the quarantine assertions without a listening socket.
        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let m = manifest.clone();
        let sender = tokio::spawn(async move {
            // hash_ok=false in the ack, so the sender is expected to fail; that
            // is pre-existing behaviour and out of scope here.
            let _ = crate::transfer::send_transfer(
                &mut theirs,
                &m,
                &[Some(bad.clone()), Some(good.clone())],
                &[],
                |_| {},
            )
            .await;
        });

        let got = receive_transfer(&mut mine, dst.path(), |_| {}, Some(&db))
            .await
            .unwrap();
        sender.await.unwrap();
        assert_eq!(got.payload_id, manifest.payload_id);

        assert_eq!(
            std::fs::read(dst.path().join("good.bin")).unwrap(),
            vec![2u8; 40_000],
            "the good item must still be delivered"
        );
        assert!(
            !dst.path().join("bad.bin").exists(),
            "the bad item must not remain at its final path"
        );
        assert!(
            dst.path()
                .join("quarantine")
                .join(hex::encode(manifest.payload_id))
                .join("bad.bin")
                .exists(),
            "the bad item must be held under out_dir/quarantine/<hex payload_id>/"
        );

        let items = db.list_items(&manifest.payload_id).unwrap();
        let states: std::collections::HashMap<u32, &str> = items
            .iter()
            .map(|i| (i.item_index, i.state.as_str()))
            .collect();
        assert_eq!(states.get(&0), Some(&"quarantined"));
        assert_eq!(states.get(&1), Some(&"received"));
        // R-T12-6: the held path is what a retry needs to find the file again.
        assert!(items[0]
            .dest_path
            .as_deref()
            .unwrap()
            .contains("quarantine"));
        // I-3: bytes_done excludes the quarantined item, so the row must say so
        // or a progress UI reads a finished transfer as half-delivered.
        let row = db.get_transfer(&manifest.payload_id).unwrap().unwrap();
        assert_eq!(row.state, "done");
        assert_eq!(row.bytes_total, 80_000);
        assert_eq!(row.bytes_done, 40_000);
        let err = row.error.unwrap();
        assert!(
            err.contains("1") && err.contains("quarantin"),
            "error must name how many items were quarantined, got {err:?}"
        );
    }

    /// R-T12-6: a GOOD transfer under db:Some persists the parent row and one
    /// row per item, so retry_item is reachable afterwards.
    #[tokio::test]
    async fn inbound_persists_the_transfer_and_item_rows() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let path = src.path().join("ok.bin");
        std::fs::write(&path, vec![5u8; 40_000]).unwrap();

        let item = Item::from_file(0, &path, 64 * 1024).unwrap();
        let manifest = Manifest::new(PayloadKind::Media, dev(), vec![item]);
        let db = crate::store::Db::open_in_memory().unwrap();
        db.migrate().unwrap();

        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let m = manifest.clone();
        let sender = tokio::spawn(async move {
            crate::transfer::send_transfer(&mut theirs, &m, &[Some(path.clone())], &[], |_| {})
                .await
                .unwrap();
        });

        receive_transfer(&mut mine, dst.path(), |_| {}, Some(&db))
            .await
            .unwrap();
        sender.await.unwrap();

        let row = db.get_transfer(&manifest.payload_id).unwrap().unwrap();
        assert_eq!(row.direction, "in");
        assert_eq!(row.state, "done");
        assert_eq!(row.peer_device_id, manifest.sender.device_id);
        assert_eq!(row.item_count, 1);
        assert_eq!(row.bytes_done, 40_000);
        assert!(!row.manifest.is_empty(), "the manifest must be persisted");

        let items = db.list_items(&manifest.payload_id).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].state, "received");
        assert_eq!(items[0].size, Some(40_000));
        assert!(items[0].dest_path.as_deref().unwrap().ends_with("ok.bin"));

        // The whole point of the row: set_item_state is now reachable.
        db.set_item_state(&manifest.payload_id, 0, "quarantined")
            .unwrap();
        assert_eq!(
            db.list_items(&manifest.payload_id).unwrap()[0].state,
            "quarantined"
        );
    }

    /// C-1: db:None can only report ONE failed item, and it must be the FIRST.
    /// A plain u32 sentinel of 0 made "item 0 failed" indistinguishable from
    /// "nothing failed yet", so the second failure overwrote it: the error named
    /// item 1 and item 1 was the file moved out of the way, leaving item 0 - a
    /// file the peer lied about - sitting at its final path.
    #[tokio::test]
    async fn two_bad_items_without_a_db_report_and_move_the_first() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let bad0 = src.path().join("bad0.bin");
        let bad1 = src.path().join("bad1.bin");
        std::fs::write(&bad0, vec![1u8; 40_000]).unwrap();
        std::fs::write(&bad1, vec![2u8; 40_000]).unwrap();

        let mut item0 = Item::from_file(0, &bad0, 64 * 1024).unwrap();
        item0.hash = Some([0u8; 32]); // deliberately wrong
        let mut item1 = Item::from_file(1, &bad1, 64 * 1024).unwrap();
        item1.hash = Some([0u8; 32]); // deliberately wrong too
        let manifest = Manifest::new(PayloadKind::Media, dev(), vec![item0, item1]);

        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let m = manifest.clone();
        let sender = tokio::spawn(async move {
            let _ = crate::transfer::send_transfer(
                &mut theirs,
                &m,
                &[Some(bad0.clone()), Some(bad1.clone())],
                &[],
                |_| {},
            )
            .await;
        });

        let res = receive_transfer(&mut mine, dst.path(), |_| {}, None).await;
        sender.await.unwrap();

        match res {
            Err(CoreError::Transfer(m)) => assert!(
                m.contains("item 0"),
                "the FIRST failed item must be the one named, got {m:?}"
            ),
            other => panic!("expected a transfer failure, got {other:?}"),
        }
        let held_root = dst
            .path()
            .join("quarantine")
            .join(hex::encode(manifest.payload_id));
        assert!(
            held_root.join("bad0.bin").exists(),
            "the item we name must be the item we move into quarantine"
        );
        assert!(
            !dst.path().join("bad0.bin").exists(),
            "the named item must not remain at its final path"
        );
        assert!(
            dst.path().join("bad1.bin").exists(),
            "db:None can only report one item, so the second stays put"
        );
    }

    /// C-2: `quarantine` is a reserved name inside out_dir. A peer that sends an
    /// item called exactly that would otherwise have the receiver open it as a
    /// FILE, breaking the quarantine root for every later transfer.
    #[tokio::test]
    async fn an_item_named_quarantine_does_not_break_the_quarantine_root() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let path = src.path().join("anything.bin");
        std::fs::write(&path, vec![6u8; 40_000]).unwrap();

        let mut item = Item::from_file(0, &path, 64 * 1024).unwrap();
        item.name = Some("quarantine".into());
        let manifest = Manifest::new(PayloadKind::Media, dev(), vec![item]);

        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let m = manifest.clone();
        let sender = tokio::spawn(async move {
            crate::transfer::send_transfer(&mut theirs, &m, &[Some(path.clone())], &[], |_| {})
                .await
                .unwrap();
        });
        receive_transfer(&mut mine, dst.path(), |_| {}, None)
            .await
            .unwrap();
        sender.await.unwrap();

        assert!(
            dst.path().join("item_0").exists(),
            "the reserved name must be remapped, not used as a filename"
        );
        assert!(
            !dst.path().join("quarantine").exists() || dst.path().join("quarantine").is_dir(),
            "quarantine must still be usable as the reserved directory"
        );

        // A second good transfer in the SAME out_dir proves the reserved
        // directory was never turned into a file.
        let src2 = tempfile::tempdir().unwrap();
        let ok = src2.path().join("later.bin");
        std::fs::write(&ok, vec![8u8; 40_000]).unwrap();
        let manifest2 = Manifest::new(
            PayloadKind::Media,
            dev(),
            vec![Item::from_file(0, &ok, 64 * 1024).unwrap()],
        );
        let (mut mine2, mut theirs2) = SecureConnection::<MemConn>::test_pair();
        let m2 = manifest2.clone();
        let sender2 = tokio::spawn(async move {
            crate::transfer::send_transfer(&mut theirs2, &m2, &[Some(ok.clone())], &[], |_| {})
                .await
                .unwrap();
        });
        receive_transfer(&mut mine2, dst.path(), |_| {}, None)
            .await
            .unwrap();
        sender2.await.unwrap();
        assert!(dst.path().join("later.bin").exists());
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
