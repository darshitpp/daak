use std::path::{Path, PathBuf};

use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use crate::chunk::ChunkBitmap;
use crate::control::AckMsg;
use crate::engine::EngineEvent;
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
/// A peer-supplied attrs["path"] is a directory-creation loop and a path the
/// OS has to resolve, so both its component count and its joined length are
/// capped. 64 components is far past any real folder share; 4096 bytes is the
/// classic PATH_MAX.
const MAX_PATH_COMPONENTS: usize = 64;
const MAX_PATH_LEN: usize = 4096;

/// D23: holds the discard directory a duplicate delivery writes into, and
/// removes it on Drop. Drop runs on the success return and on every error
/// return, so the cleanup needs no second call at each `?`.
struct DiscardGuard(Option<PathBuf>);

impl Drop for DiscardGuard {
    fn drop(&mut self) {
        if let Some(dir) = &self.0 {
            let _ = std::fs::remove_dir_all(dir);
            // Best effort: also remove the shared root. This succeeds only
            // when no other duplicate delivery is writing there.
            if let Some(parent) = dir.parent() {
                let _ = std::fs::remove_dir(parent);
            }
        }
    }
}

fn safe_item_name(item: &Item) -> String {
    let raw = item.name.as_deref().unwrap_or("");
    match Path::new(raw).file_name().and_then(|n| n.to_str()) {
        Some(n) if !n.is_empty() && !is_reserved(n) => with_mime_extension(n, item.mime.as_deref()),
        _ => format!("item_{}", item.index),
    }
}

/// R42o: a sender that cannot resolve a display name sends one with no
/// extension, and the receiver stored an unopenable file. Measured: an Android
/// content-URI pick produced `image:1000196782`. The sender is fixed, and this
/// is the second line of defence -- the item's own `mime` names the type, so
/// the extension is derived from it when the name has none.
///
/// It only ADDS. A name that already carries an extension keeps it, even when
/// the mime disagrees: the name is the user's, and the mime is a hint from a
/// device that may have guessed it.
fn with_mime_extension(name: &str, mime: Option<&str>) -> String {
    if Path::new(name).extension().is_some() {
        return name.to_owned();
    }
    match mime.and_then(extension_for_mime) {
        Some(ext) => format!("{name}.{ext}"),
        None => name.to_owned(),
    }
}

/// The common types, by their registered extension. An unlisted or malformed
/// mime yields nothing rather than a made-up extension: `.bin` on a JPEG is a
/// worse lie than no extension at all.
fn extension_for_mime(mime: &str) -> Option<&'static str> {
    let m = mime.split(';').next()?.trim().to_ascii_lowercase();
    Some(match m.as_str() {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/heic" => "heic",
        "image/heif" => "heif",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "audio/mpeg" => "mp3",
        "audio/mp4" => "m4a",
        "audio/wav" => "wav",
        "audio/ogg" => "ogg",
        "application/pdf" => "pdf",
        "application/zip" => "zip",
        "text/plain" => "txt",
        "text/csv" => "csv",
        "application/json" => "json",
        _ => return None,
    })
}

/// Names the receiver owns inside out_dir. `quarantine` holds items whose hash
/// failed; `staging` is the OUTBOUND staging root engine.rs creates there, with
/// live staged files for sends in flight. A peer naming either as a file would
/// break the directory it is about to use.
fn is_reserved(name: &str) -> bool {
    matches!(name, "." | ".." | "quarantine" | "staging")
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

/// B1: a folder share arrives FLAT -- one item per file, each carrying its
/// path relative to the share root in attrs["path"]. This is where the tree
/// comes back. Every component is run through the same `safe_item_name` filter
/// as `name`, so a peer-supplied path cannot escape out_dir, address the
/// reserved `quarantine` root, or name a device (`C:` on Windows).
pub(crate) fn item_destination(out_dir: &Path, item: &Item) -> Result<PathBuf> {
    let rel = match item.attrs.get("path") {
        Some(ciborium::value::Value::Text(rel)) => rel.as_str(),
        // No relative path, or one of the wrong type: the bare name, which is
        // exactly where the item would have gone before B1.
        _ => return item_output_path(out_dir, item),
    };
    let components = safe_components(rel, item.index)?;
    if components.is_empty() {
        // attrs["path"] was pure traversal: the item lands at its bare name
        // rather than at out_dir itself, which would be a DIRECTORY where the
        // receiver is about to open a file.
        return item_output_path(out_dir, item);
    }
    Ok(components
        .into_iter()
        .fold(out_dir.to_path_buf(), |mut dir, c| {
            dir.push(c);
            dir
        }))
}

/// The SANITISED components of a relative path, in order: the one place the
/// split, the traversal filter, the reserved-component remap and both caps
/// live. `pub(crate)` so the builder reserves the destination it is about to
/// claim by asking THIS rather than re-deriving the loop -- two copies of
/// "what does this attrs["path"] become" is exactly the drift that let the
/// builder claim a destination the receiver remaps elsewhere.
pub(crate) fn safe_components(rel: &str, index: u32) -> Result<Vec<String>> {
    // Both caps are on the PEER's string, before it becomes a mkdir loop or a
    // path the OS has to resolve.
    if rel.len() > MAX_PATH_LEN {
        return Err(CoreError::Protocol(format!(
            "item {} relative path length {} exceeds cap {MAX_PATH_LEN}",
            index,
            rel.len()
        )));
    }
    let mut kept: Vec<String> = Vec::new();
    for component in rel.split(['/', '\\']) {
        if component.is_empty() || component == "." || component == ".." {
            continue;
        }
        if kept.len() == MAX_PATH_COMPONENTS {
            return Err(CoreError::Protocol(format!(
                "item {} relative path has more than {MAX_PATH_COMPONENTS} components",
                index
            )));
        }
        kept.push(safe_component(component, index));
    }
    Ok(kept)
}

/// One sanitised path component, component-wise: the builder reserving
/// `sub/quarantine` must get `sub/item_{index}`, not a top-level `item_{index}`.
pub(crate) fn safe_component(raw: &str, index: u32) -> String {
    match Path::new(raw).file_name().and_then(|n| n.to_str()) {
        Some(n) if !n.is_empty() && !is_reserved(n) => n.to_owned(),
        _ => format!("item_{index}"),
    }
}

/// Create the directory chain `parent` needs under `out_dir`, verifying EVERY
/// component with `symlink_metadata` BEFORE creating anything beneath it.
///
/// F3. This must NOT be `create_dir_all`. `create_dir_all` walks the chain
/// first, so a symlink planted at `out_dir/a` is FOLLOWED and the real
/// directory `out_dir/a/b` appears to be created -- after the fact,
/// `symlink_metadata(out_dir/a/b)` sees a plain directory and the escape is
/// invisible. Worse, the write then lands outside `out_dir` entirely, from a
/// peer that only had to pick a name. out_dir is long-lived and every
/// non-reserved peer-chosen name is fair game for a directory component, so a
/// prior delivery can plant the symlink and a later one walks through it.
///
/// Per-component `create_dir` (not `create_dir_all`) is the cheapest correct
/// form: it creates exactly one level, so a component that already exists
/// surfaces as AlreadyExists and gets re-verified here, and the deepest
/// existing prefix is checked before we descend into it. Nothing is created
/// beneath a component we have not confirmed to be a real directory.
///
/// NOT canonicalise-and-recompare: on macOS /var and /private/var are one
/// directory under two names, so comparing canonical forms would reject every
/// honest receive into a tempdir.
///
/// Residual race, accepted: a component that is a real directory when we stat
/// it can still be swapped for a symlink before the write below. It is defence
/// in depth, not a privilege boundary -- the attacker would already need write
/// access to the receiver's own out_dir, which is what lets them write the
/// victim file directly.
async fn ensure_real_dir_chain(out_dir: &Path, parent: &Path, index: u32) -> Result<()> {
    let rel = parent.strip_prefix(out_dir).map_err(|_| {
        CoreError::Protocol(format!(
            "item {index} destination {} is outside the output directory",
            parent.display()
        ))
    })?;
    let mut dir = out_dir.to_path_buf();
    for component in rel.components() {
        dir.push(component);
        match tokio::fs::symlink_metadata(&dir).await {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(CoreError::Protocol(format!(
                    "item {index} destination {} traverses the symlink {}",
                    parent.display(),
                    dir.display()
                )));
            }
            // An existing FILE cannot become a directory, and descending into it
            // is not what the peer asked for.
            Ok(m) if !m.is_dir() => {
                return Err(CoreError::Protocol(format!(
                    "item {index} destination {} is blocked by the non-directory {}",
                    parent.display(),
                    dir.display()
                )));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // The component does not exist yet, so by the match arm above
                // it is not a symlink. Create exactly this one level and move
                // on; the next iteration verifies whatever is beneath it.
                match tokio::fs::create_dir(&dir).await {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(e) => {
                        return Err(CoreError::Protocol(format!(
                            "item {index} cannot create {}: {e}",
                            dir.display()
                        )));
                    }
                }
            }
            // Unrelated to the symlink concern: a path we cannot even stat (a
            // permissions wall, an I/O error) is not something to write through.
            Err(e) => {
                return Err(CoreError::Protocol(format!(
                    "item {index} destination {} is not inspectable: {e}",
                    dir.display()
                )));
            }
        }
    }
    Ok(())
}

pub(crate) fn validate_manifest(manifest: &Manifest) -> Result<()> {
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
    // F4: two items resolving to the SAME destination both open that file and
    // write interleaved chunks into it. The key is the RESOLVED destination of
    // EVERY binary item, not the raw attrs["path"], because the two populations
    // resolve by different routes: a loose picked file carries no attrs["path"]
    // at all and lands at out_dir/<safe name>, while a folder child carries one
    // and lands at out_dir/<sanitised path>. Restricting the check to items with
    // a Text attrs["path"] therefore left a cross-population collision
    // invisible -- a file plus a folder containing a top-level file of the same
    // name, which is what the iOS share sheet produces. `item_destination`
    // already falls back to `item_output_path` for an absent or non-Text path,
    // so iterating every binary item covers all three cases.
    //
    // BACKSTOP, not the fix. The collision is CREATED by the builder, and
    // from_picked_paths now prevents it: every loose file's destination and
    // every folder child's attrs["path"] go through one `dests` set there, so a
    // manifest the builder produces has pairwise-distinct destinations and this
    // loop never fires on it (pinned by the socket-free unit tests in
    // manifest.rs). What is left here is defence against a hand-built or
    // hostile manifest -- the one case the peer fully controls -- and the
    // cheap place to catch it, before a byte is written or a file created.
    // Tightening this check alone, without the builder fix, rejected our OWN
    // sender's output and wedged send_transfer in its ack loop.
    // Non-binary items are never materialised, so they cannot collide.
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    for item in manifest.items.iter().filter(|i| i.is_binary()) {
        let dest = item_destination(Path::new(""), item)?;
        if !seen.insert(dest.clone()) {
            return Err(CoreError::Protocol(format!(
                "item {} resolves to an already-claimed destination {}",
                item.index,
                dest.display()
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
    on_item: impl FnMut(EngineEvent),
) -> Result<Manifest> {
    receive_transfer_from(conn, None, out_dir, |_, n, _| on_progress(n), db, on_item).await
}

/// Like `receive_transfer`. With `Some(id)`, the manifest must name `id` as its
/// sender. The caller passes the device id of the authenticated peer.
pub async fn receive_transfer_from<T: FrameTransport>(
    conn: &mut T,
    expected_sender: Option<[u8; 16]>,
    out_dir: &Path,
    // (payload id, chunk length, bytes total). The receiver knows the id and
    // the total only after it parses the manifest, so both travel with each
    // progress call (P4 Task 12).
    mut on_progress: impl FnMut([u8; 16], u64, u64),
    db: Option<&Db>,
    mut on_item: impl FnMut(EngineEvent),
) -> Result<Manifest> {
    let manifest = loop {
        match conn.recv().await? {
            Some(f) if f.kind == RecordType::Manifest => break Manifest::from_cbor(&f.body)?,
            Some(f) if f.kind == RecordType::Control => {
                if let Ok(crate::control::ControlMsg::Unpair) =
                    crate::control::ControlMsg::from_cbor(&f.body)
                {
                    return Err(CoreError::PeerUnpaired);
                }
            }
            Some(_) => continue,
            None => return Err(CoreError::Protocol("closed before manifest".into())),
        }
    };

    validate_manifest(&manifest)?;
    if expected_sender.is_some_and(|id| id != manifest.sender.device_id) {
        return Err(CoreError::Protocol(
            "manifest sender is not the authenticated peer".into(),
        ));
    }

    // One sum for the row and for the progress events. A non-binary item is
    // never materialised, so its size must not count (B2).
    let bytes_total: u64 = manifest.binary_items().filter_map(|i| i.size).sum();

    // D23: a re-delivery of a payload_id that is already in the inbox must not
    // write into the real destination. A half-written duplicate would truncate
    // the first good copy. Every item write goes to a discard directory
    // instead, and the sender still gets its Ack so it stops re-sending. The
    // guard removes the directory on every return path.
    let dedupe = match db {
        Some(db) => db.payload_seen(&manifest.payload_id)?,
        None => false,
    };
    let dest_root = if dedupe {
        out_dir
            .join("dedupe-discard")
            .join(hex::encode(manifest.payload_id))
    } else {
        out_dir.to_path_buf()
    };
    let _discard = DiscardGuard(dedupe.then(|| dest_root.clone()));

    tokio::fs::create_dir_all(&dest_root).await?;
    // R-T12-6: with a Db supplied, the inbound transfer becomes a real row so a
    // quarantined item has something to point at and `retry_item` can find it.
    // Db::upsert_transfer's ON CONFLICT branch leaves payload_id/peer/kind/
    // direction alone, so the second (final) upsert is safe.
    if let Some(db) = db.filter(|_| !dedupe) {
        let now = crate::manifest::now_ms() as i64 / 1000;
        db.upsert_transfer(&TransferRow {
            transfer_id: manifest.payload_id,
            payload_id: manifest.payload_id,
            peer_device_id: manifest.sender.device_id,
            direction: "in".into(),
            kind: format!("{:?}", manifest.kind).to_lowercase(),
            state: "active".into(),
            // B2: bytes_total is the bytes that will be WRITTEN. A non-binary
            // item is never materialised (see the dest_path note below), so a
            // size the peer attached to one must not be counted -- otherwise the
            // UI shows 100% for a file that does not exist. is_binary(), not
            // size.is_some(): any peer can put a size on a Text/Folder item.
            bytes_total,
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
        let path = item_destination(&dest_root, item)?;
        if let Some(parent) = path.parent() {
            // B1: a folder's children arrive in subdirectories that do not
            // exist yet on the receiver.
            ensure_real_dir_chain(&dest_root, parent, item.index).await?;
        }
        // Open without truncating: a resumed receive must preserve already-written
        // partial chunks so the persisted bitmap still points at real on-disk data.
        let f = tokio::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .await?;
        files.push(Some(f));
        // B1: a resumed folder share reconnects and the sender only re-sends the
        // chunks it was NACKed for, so a blank bitmap would leave the receive
        // blocked forever on a chunk that is already on disk. Load the
        // persisted state instead. R-T7-5 key policy: payload_id, never a
        // separate transfer id -- that is what the resuming peer NACKs against.
        //
        // TRUST: a persisted bitmap is a HINT, never authority. ChunkBitmap has
        // no "unset" state, so "nothing persisted" and "every chunk
        // persisted" are indistinguishable here except via is_complete(); this
        // code does not care which it is. A stale or lying row can at worst make
        // the receive wait for a chunk the peer already believes it sent, or
        // re-write a chunk -- both benign, because the per-item BLAKE2b at the
        // end of this function is the sole authority on done vs quarantined. That
        // hash is why this needs no extra get_transfer lookup: the query would
        // buy nothing the hash does not already decide.
        //
        // A bitmap persisted under a DIFFERENT chunk_count is benign: set_word
        // drops words past this bitmap's end, so both shortening (stale extra
        // words ignored) and lengthening (new tail still zero) stay safe.
        let bitmap = match db {
            Some(db) => db.load_bitmap(&manifest.payload_id, item.index, chunk_count)?,
            None => ChunkBitmap::new(chunk_count),
        };
        bitmaps.push(Some(bitmap));
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
        let end = offset.checked_add(data.len() as u64).ok_or_else(|| {
            CoreError::Protocol(format!("chunk for item {item_index} overflows file size"))
        })?;
        // A chunk longer than the chunk size overwrites its neighbours. A chunk
        // that ends past the declared size grows the file. Both use disk that
        // the manifest did not announce.
        if data.len() as u64 > chunk_size as u64
            || manifest.items[idx].size.is_some_and(|sz| end > sz)
        {
            return Err(CoreError::Protocol(format!(
                "chunk {chunk_index} of item {item_index} exceeds the declared size"
            )));
        }

        let file = files
            .get_mut(idx)
            .and_then(|f| f.as_mut())
            .ok_or_else(|| CoreError::Protocol(format!("chunk for unknown item {item_index}")))?;
        file.seek(std::io::SeekFrom::Start(offset)).await?;
        file.write_all(&data).await?;
        on_progress(manifest.payload_id, data.len() as u64, bytes_total);
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
    // In the dedupe case dest_root is the discard directory, so a corrupt
    // duplicate is held there and removed with it. The real file is untouched.
    let quarantine = Quarantine::new(dest_root.join("quarantine"));
    let mut hash_ok = true;
    // C-1: Option, not a u32 sentinel of 0 - item 0 failing used to leave the
    // sentinel unset so the NEXT failure overwrote the reported item.
    let mut failed_item: Option<u32> = None;
    // Every item whose hash DID fail, whether or not the move into quarantine
    // succeeded (I-4): the DB state follows the hash, not the rename.
    let mut failed: Vec<u32> = Vec::new();
    let mut held_paths: Vec<(u32, PathBuf)> = Vec::new();
    for item in manifest.binary_items() {
        let path = item_destination(&dest_root, item)?;
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
    if let Some(db) = db.filter(|_| !dedupe) {
        let mut bytes_done = 0u64;
        for item in &manifest.items {
            let quarantined = failed.contains(&item.index);
            // Computed ONCE and used for BOTH the row and the event below, so
            // the two can never name two different files.
            //
            // Non-binary items are never materialised, so a dest_path for them
            // would point at a file that can never exist.
            let dest_path: Option<String> = if !item.is_binary() {
                None
            } else {
                let dest = match held_paths.iter().find(|(i, _)| *i == item.index) {
                    Some((_, p)) => p.clone(),
                    None => item_destination(out_dir, item)?,
                };
                dest.to_str().map(|s| s.to_string())
            };
            // W-FW-1: "done", not "received" - spec 4.2 enumerates the only
            // legal transfer_items.state values and "received" is not one of
            // them. The DB is the source of truth, so an undocumented value
            // here is a breaking contract for Phase 4.
            let state = if quarantined { "quarantined" } else { "done" };
            db.upsert_item(&ItemRow {
                transfer_id: manifest.payload_id,
                item_index: item.index,
                item_type: item.item_type.as_str().to_string(),
                name: item.name.clone(),
                mime: item.mime.clone(),
                size: item.size,
                hash: item.hash,
                dest_path: dest_path.clone(),
                state: state.into(),
            })?;
            // AFTER the write, not before: an event for a row that does not
            // exist is a lie, and this whole block is inside `if let Some(db)`
            // so with no db there is no row and no event.
            on_item(EngineEvent::TransferItem {
                transfer_id: manifest.payload_id,
                item_index: item.index,
                state: state.into(),
                dest_path,
            });
            if !quarantined && item.is_binary() {
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
            // Same rule as the initial upsert above: only materialised items
            // have bytes. item_count below still counts every item.
            bytes_total,
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
            let good = item_destination(out_dir, item)?;
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
    use crate::engine::EngineEvent;
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
        let res = receive_transfer(&mut conn, out, |_| {}, None, |_| {}).await;
        sender.await.unwrap();
        res
    }

    /// The manifest names its own sender. A paired peer must not name another
    /// paired device there: the inbox and the quarantine report would show it.
    #[tokio::test]
    async fn a_manifest_that_names_another_sender_is_refused() {
        let manifest = Manifest::new(PayloadKind::Batch, dev(), vec![peer_item(0, "a.bin")]);
        for (expected, ok) in [([8u8; 16], false), ([7u8; 16], true)] {
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
            let dst = tempfile::tempdir().unwrap();
            let res = receive_transfer_from(
                &mut conn,
                Some(expected),
                dst.path(),
                |_, _, _| {},
                None,
                |_| {},
            )
            .await;
            sender.await.unwrap();
            if ok {
                assert!(!matches!(res, Err(CoreError::Protocol(ref m)) if m.contains("sender")));
            } else {
                assert!(matches!(res, Err(CoreError::Protocol(m)) if m.contains("sender")));
            }
        }
    }

    // ---- R116: the per-item EngineEvent the UI's ReceivedItemRow renders ----

    /// Drive receive_transfer and collect the EngineEvents it emits, so the
    /// emit site itself is under test rather than a hand-built event.
    async fn receive_collecting_events<T: FrameTransport>(
        conn: &mut T,
        out_dir: &std::path::Path,
        db: Option<&Db>,
    ) -> (Result<Manifest>, Vec<EngineEvent>) {
        let (tx, mut rx) = tokio::sync::broadcast::channel(64);
        let res = receive_transfer(
            conn,
            out_dir,
            |_| {},
            db,
            |ev| {
                let _ = tx.send(ev);
            },
        )
        .await;
        let mut evs = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            evs.push(ev);
        }
        (res, evs)
    }

    fn item_events(evs: &[EngineEvent], id: [u8; 16]) -> Vec<(u32, String, Option<String>)> {
        evs.iter()
            .filter_map(|e| match e {
                EngineEvent::TransferItem {
                    transfer_id,
                    item_index,
                    state,
                    dest_path,
                } if *transfer_id == id => Some((*item_index, state.clone(), dest_path.clone())),
                _ => None,
            })
            .collect()
    }

    /// A GOOD item emits 'done' with the path it actually wrote to -- the same
    /// expression the ItemRow literal uses, so the event and the row cannot
    /// drift into naming two different files.
    #[tokio::test]
    async fn emits_a_transfer_item_event_per_good_item_with_its_real_path() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let path = src.path().join("ok.bin");
        std::fs::write(&path, vec![5u8; 40_000]).unwrap();

        let item = Item::from_file(0, &path, 64 * 1024).unwrap();
        let manifest = Manifest::new(PayloadKind::Media, dev(), vec![item]);
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();

        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let m = manifest.clone();
        let sender = tokio::spawn(async move {
            crate::transfer::send_transfer(&mut theirs, &m, &[Some(path)], &[], |_| {})
                .await
                .unwrap();
        });

        let (_, evs) = receive_collecting_events(&mut mine, dst.path(), Some(&db)).await;
        sender.await.unwrap();

        let got = item_events(&evs, manifest.payload_id);
        assert_eq!(got.len(), 1, "exactly one event per item, got {got:?}");
        assert_eq!(got[0].0, 0);
        assert_eq!(got[0].1, "done");
        // The REAL dest_path, identical to the persisted row's, not a guess.
        assert_eq!(
            got[0].2.as_deref(),
            db.list_items(&manifest.payload_id).unwrap()[0]
                .dest_path
                .as_deref()
        );
        assert!(got[0].2.as_deref().unwrap().ends_with("ok.bin"));
    }

    /// A hash-mismatched item emits 'quarantined' and the HELD path, not the
    /// final path it no longer occupies.
    #[tokio::test]
    async fn emits_quarantined_with_the_held_path_for_a_hash_failed_item() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let bad = src.path().join("bad.bin");
        std::fs::write(&bad, vec![1u8; 40_000]).unwrap();

        let mut bad_item = Item::from_file(0, &bad, 64 * 1024).unwrap();
        bad_item.hash = Some([0u8; 32]);
        let manifest = Manifest::new(PayloadKind::Media, dev(), vec![bad_item]);
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();

        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let m = manifest.clone();
        let sender = tokio::spawn(async move {
            let _ =
                crate::transfer::send_transfer(&mut theirs, &m, &[Some(bad)], &[], |_| {}).await;
        });

        let (res, evs) = receive_collecting_events(&mut mine, dst.path(), Some(&db)).await;
        sender.await.unwrap();
        res.unwrap();

        let got = item_events(&evs, manifest.payload_id);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].1, "quarantined");
        let dest = got[0].2.as_deref().expect("a held path is a real path");
        assert!(dest.contains("quarantine"), "got {dest}");
        assert!(Path::new(dest).exists(), "the held file must exist: {dest}");
    }

    /// A TEXT item is never materialised, so its event must carry dest_path
    /// None. Copying the binary branch here is the silent break: the event
    /// would name a file that can never exist, which is exactly what the
    /// ItemRow comment at receiver.rs:314-317 refuses to do.
    #[tokio::test]
    async fn emits_a_text_item_with_no_dest_path() {
        let dst = tempfile::tempdir().unwrap();
        let manifest = Manifest::new(
            PayloadKind::Text,
            dev(),
            vec![Item::text(0, "hello from the other device")],
        );
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();

        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let m = manifest.clone();
        let sender = tokio::spawn(async move {
            crate::transfer::send_transfer(&mut theirs, &m, &[None], &[], |_| {})
                .await
                .unwrap();
        });

        let (_, evs) = receive_collecting_events(&mut mine, dst.path(), Some(&db)).await;
        sender.await.unwrap();

        let got = item_events(&evs, manifest.payload_id);
        assert_eq!(got.len(), 1, "got {got:?}");
        assert_eq!(got[0].1, "done");
        assert_eq!(
            got[0].2, None,
            "a text item is never materialised, so it has no dest_path"
        );
    }

    /// With db:None there is no row, so an event claiming one would be a lie.
    #[tokio::test]
    async fn emits_no_item_event_without_a_db() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let path = src.path().join("ok.bin");
        std::fs::write(&path, vec![5u8; 40_000]).unwrap();
        let item = Item::from_file(0, &path, 64 * 1024).unwrap();
        let manifest = Manifest::new(PayloadKind::Media, dev(), vec![item]);

        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let m = manifest.clone();
        let sender = tokio::spawn(async move {
            crate::transfer::send_transfer(&mut theirs, &m, &[Some(path)], &[], |_| {})
                .await
                .unwrap();
        });

        let (_, evs) = receive_collecting_events(&mut mine, dst.path(), None).await;
        sender.await.unwrap();

        assert!(
            item_events(&evs, manifest.payload_id).is_empty(),
            "no db means no persisted row, so no row-claiming event: {evs:?}"
        );
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
        let got = receive_transfer(&mut conn, dst.path(), |_| {}, None, |_| {})
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

        let res = receive_transfer(&mut mine, dst.path(), |_| {}, None, |_| {}).await;
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

        let got = receive_transfer(&mut mine, dst.path(), |_| {}, Some(&db), |_| {})
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
        assert_eq!(states.get(&1), Some(&"done"));
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

    // The peer unpaired this device. The notice arrives where a manifest is
    // expected, on the authenticated session, and ends the receive.
    #[tokio::test]
    async fn an_unpair_notice_ends_the_receive_with_peer_unpaired() {
        let dst = tempfile::tempdir().unwrap();
        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let notice = crate::control::ControlMsg::Unpair.to_cbor().unwrap();
        theirs
            .send(CONTROL_STREAM, RecordType::Control, Bytes::from(notice))
            .await
            .unwrap();
        let r = receive_transfer(&mut mine, dst.path(), |_| {}, None, |_| {}).await;
        assert!(matches!(r, Err(CoreError::PeerUnpaired)), "got {r:?}");
    }

    // B2: a peer can put ANY size on a non-binary item. Nothing is ever
    // written for it, so it must contribute 0 to bytes_total and bytes_done --
    // while item_count still counts it, because it IS an item.
    #[tokio::test]
    async fn a_sized_text_item_counts_as_an_item_but_not_as_bytes() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let f = src.path().join("real.bin");
        std::fs::write(&f, vec![3u8; 10_000]).unwrap();

        let mut text = Item::text(0, "note");
        text.size = Some(500_000); // no file will ever exist for this
        let manifest = Manifest::new(
            PayloadKind::Batch,
            dev(),
            vec![text, Item::from_file(1, &f, 64 * 1024).unwrap()],
        );

        let db = crate::store::Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let m = manifest.clone();
        let sender = tokio::spawn(async move {
            let _ = crate::transfer::send_transfer(
                &mut theirs,
                &m,
                &[None, Some(f.clone())],
                &[],
                |_| {},
            )
            .await;
        });
        receive_transfer(&mut mine, dst.path(), |_| {}, Some(&db), |_| {})
            .await
            .unwrap();
        sender.await.unwrap();

        let row = db.get_transfer(&manifest.payload_id).unwrap().unwrap();
        assert_eq!(row.bytes_total, 10_000);
        assert_eq!(row.bytes_done, 10_000);
        assert_eq!(row.item_count, 2);
    }

    // B2 regression guard: a pure-binary transfer is unchanged. The fix must
    // not be "zero everything".
    #[tokio::test]
    async fn a_pure_binary_transfer_counts_every_real_byte() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let a = src.path().join("a.bin");
        let b = src.path().join("b.bin");
        std::fs::write(&a, vec![1u8; 40_000]).unwrap();
        std::fs::write(&b, vec![2u8; 15_000]).unwrap();
        let manifest = Manifest::new(
            PayloadKind::Batch,
            dev(),
            vec![
                Item::from_file(0, &a, 64 * 1024).unwrap(),
                Item::from_file(1, &b, 64 * 1024).unwrap(),
            ],
        );

        let db = crate::store::Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let m = manifest.clone();
        let sender = tokio::spawn(async move {
            let _ = crate::transfer::send_transfer(
                &mut theirs,
                &m,
                &[Some(a.clone()), Some(b.clone())],
                &[],
                |_| {},
            )
            .await;
        });
        receive_transfer(&mut mine, dst.path(), |_| {}, Some(&db), |_| {})
            .await
            .unwrap();
        sender.await.unwrap();

        let row = db.get_transfer(&manifest.payload_id).unwrap().unwrap();
        assert_eq!(row.bytes_total, 55_000);
        assert_eq!(row.bytes_done, 55_000);
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

        receive_transfer(&mut mine, dst.path(), |_| {}, Some(&db), |_| {})
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
        assert_eq!(items[0].state, "done");
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

    /// D23: a second delivery of the SAME payload_id must not write into the
    /// real destination. A half-written duplicate must not truncate the first
    /// good copy. The duplicate lands in a discard directory that is removed
    /// before the return, and the sender still gets its Ack.
    #[tokio::test]
    async fn a_duplicate_delivery_leaves_the_real_file_untouched() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let path = src.path().join("ok.bin");
        let payload: Vec<u8> = (0..120_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &payload).unwrap();

        let item = Item::from_file(0, &path, 64 * 1024).unwrap();
        let manifest = Manifest::new(PayloadKind::Media, dev(), vec![item]);
        let db = crate::store::Db::open_in_memory().unwrap();
        db.migrate().unwrap();

        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let m = manifest.clone();
        let sender = tokio::spawn(async move {
            for _ in 0..2 {
                crate::transfer::send_transfer(&mut theirs, &m, &[Some(path.clone())], &[], |_| {})
                    .await
                    .unwrap();
            }
        });

        // First delivery writes the real file.
        receive_transfer(&mut mine, dst.path(), |_| {}, Some(&db), |_| {})
            .await
            .unwrap();
        let written = dst.path().join("ok.bin");
        assert_eq!(std::fs::read(&written).unwrap(), payload);

        // The engine records the inbox row after the first delivery, so the
        // second delivery sees the payload as already stored.
        db.add_inbox(&crate::store::inbox::InboxRow {
            id: manifest.payload_id,
            transfer_id: manifest.payload_id,
            peer_device_id: manifest.sender.device_id,
            kind: "media".into(),
            item_count: 1,
            summary: "1 file(s)".into(),
            received_at: 1,
            saved_paths: "[]".into(),
        })
        .unwrap();
        assert!(db.payload_seen(&manifest.payload_id).unwrap());

        // Distinct bytes prove the duplicate cannot truncate a good file.
        std::fs::write(&written, b"first copy stays").unwrap();

        // Second delivery of the SAME payload_id.
        receive_transfer(&mut mine, dst.path(), |_| {}, Some(&db), |_| {})
            .await
            .unwrap();
        sender.await.unwrap();

        assert!(
            std::fs::read(&written).unwrap() == b"first copy stays",
            "the duplicate delivery must not touch the first copy"
        );
        assert_eq!(db.list_inbox().unwrap().len(), 1);
        assert!(
            !dst.path().join("dedupe-discard").exists(),
            "the discard directory must be removed before the return"
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

        let res = receive_transfer(&mut mine, dst.path(), |_| {}, None, |_| {}).await;
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
        receive_transfer(&mut mine, dst.path(), |_| {}, None, |_| {})
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
        receive_transfer(&mut mine2, dst.path(), |_| {}, None, |_| {})
            .await
            .unwrap();
        sender2.await.unwrap();
        assert!(dst.path().join("later.bin").exists());
    }

    // ---- B1: a folder's children keep their place in the tree ----

    /// B1: the sender flattens a folder into one binary item per file, each
    /// carrying its share-root-relative path in attrs["path"]. The receiver has
    /// to put each one back at that path, or a shared folder arrives as a pile
    /// of loose files. Assert the TREE, not the item list.
    #[tokio::test]
    async fn an_item_with_a_relative_path_attribute_lands_inside_its_folder() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let path = src.path().join("photo.jpg");
        let payload: Vec<u8> = (0..70_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &payload).unwrap();

        let mut item = Item::from_file(0, &path, 64 * 1024).unwrap();
        item.attrs.insert(
            "path".into(),
            ciborium::value::Value::Text("album/holiday/photo.jpg".into()),
        );
        let manifest = Manifest::new(PayloadKind::Batch, dev(), vec![item]);

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
        receive_transfer(&mut conn, dst.path(), |_| {}, None, |_| {})
            .await
            .unwrap();
        sender.await.unwrap();

        assert_eq!(
            std::fs::read(dst.path().join("album/holiday/photo.jpg")).unwrap(),
            payload,
            "a folder's child must keep its place in the tree"
        );
    }

    /// B1 trust boundary: attrs is peer-controlled, exactly like name, so a
    /// relative path from the wire is sanitised component by component.
    #[tokio::test]
    async fn a_relative_path_cannot_escape_the_output_directory() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let path = src.path().join("x.bin");
        std::fs::write(&path, vec![4u8; 40_000]).unwrap();

        let mut item = Item::from_file(0, &path, 64 * 1024).unwrap();
        item.attrs.insert(
            "path".into(),
            ciborium::value::Value::Text("../../escaped.bin".into()),
        );
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
        receive_transfer(&mut conn, dst.path(), |_| {}, None, |_| {})
            .await
            .unwrap();
        sender.await.unwrap();

        assert!(
            dst.path().join("escaped.bin").exists(),
            "the traversal prefix must be stripped, leaving the file in out_dir"
        );
        assert!(
            !dst.path().parent().unwrap().join("escaped.bin").exists(),
            "a peer-supplied relative path must not escape out_dir"
        );
    }

    // ---- FIX PASS: the folder tree is a peer-controlled write path ----

    /// A hand-built item, so a path/caps test needs no real file on disk.
    // R42o: a sender that cannot resolve a display name sends one with no
    // extension, and the receiver stored a file the OS cannot open. The item's
    // own mime names the type, so the extension is derived from it.
    #[test]
    fn a_name_without_an_extension_takes_one_from_the_mime() {
        let mut item = peer_item(0, "x");
        item.name = Some("image:1000196782".into());
        item.mime = Some("image/jpeg".into());
        assert_eq!(safe_item_name(&item), "image:1000196782.jpg");
    }

    // The name is the user's and the mime is a hint from another device, so a
    // name that already carries an extension keeps it, and an unlisted mime
    // adds nothing rather than inventing one.
    #[test]
    fn an_existing_extension_and_an_unknown_mime_are_left_alone() {
        let mut item = peer_item(0, "x");
        item.name = Some("holiday.png".into());
        item.mime = Some("image/jpeg".into());
        assert_eq!(safe_item_name(&item), "holiday.png");

        item.name = Some("notes".into());
        item.mime = Some("application/x-made-up".into());
        assert_eq!(safe_item_name(&item), "notes");
    }

    fn peer_item(index: u32, rel: &str) -> Item {
        let mut item = Item {
            index,
            item_type: ItemType::Document,
            name: Some(format!("f{index}.bin")),
            size: Some(100),
            chunk_size: Some(CHUNK_SIZE_MIN),
            chunk_count: Some(1),
            ..Default::default()
        };
        item.attrs
            .insert("path".into(), ciborium::value::Value::Text(rel.to_string()));
        item
    }

    /// F3: a symlink ALREADY inside out_dir defeats the per-component filter,
    /// because create_dir_all(parent) follows it and the OpenOptions write goes
    /// straight through it. MemConn, so no socket is needed.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_symlink_inside_out_dir_cannot_carry_a_write_out_of_it() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let path = src.path().join("x.bin");
        std::fs::write(&path, vec![5u8; 40_000]).unwrap();

        let mut item = Item::from_file(0, &path, 64 * 1024).unwrap();
        item.attrs.insert(
            "path".into(),
            ciborium::value::Value::Text("sub/planted.bin".into()),
        );
        let manifest = Manifest::new(PayloadKind::Media, dev(), vec![item]);

        // The attacker (or an earlier share) put a symlink exactly where the
        // receive is about to make a directory.
        std::os::unix::fs::symlink(outside.path(), dst.path().join("sub")).unwrap();

        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let m = manifest.clone();
        let sender = tokio::spawn(async move {
            let _ =
                crate::transfer::send_transfer(&mut theirs, &m, &[Some(path.clone())], &[], |_| {})
                    .await;
        });
        let res = receive_transfer(&mut mine, dst.path(), |_| {}, None, |_| {}).await;
        sender.abort();

        assert!(
            matches!(res, Err(CoreError::Protocol(_))),
            "writing through a symlinked directory must be refused, got {res:?}"
        );
        assert!(
            !outside.path().join("planted.bin").exists(),
            "no byte may land outside out_dir"
        );
    }

    /// F3, DEEP half, and the one that was actually exploitable. The single-
    /// component test above plants the symlink at the FINAL parent, so the
    /// post-hoc `symlink_metadata(parent)` sees the symlink and refuses. Plant
    /// it one level UP and that check inspects a plain directory that
    /// `create_dir_all` only just created *through* the symlink, so it passes
    /// and the write lands outside out_dir. Every component of the path has to
    /// be verified before anything is created beneath it.
    #[tokio::test]
    async fn a_symlink_below_an_intermediate_component_cannot_carry_a_write_out_of_it() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let path = src.path().join("x.bin");
        std::fs::write(&path, vec![7u8; 40_000]).unwrap();

        let mut item = Item::from_file(0, &path, 64 * 1024).unwrap();
        item.attrs.insert(
            "path".into(),
            ciborium::value::Value::Text("planted/deep/leaf.bin".into()),
        );
        let manifest = Manifest::new(PayloadKind::Media, dev(), vec![item]);

        // The first component is a symlink pointing out of out_dir; the two
        // components BELOW it do not exist yet and will be created through it.
        std::os::unix::fs::symlink(outside.path(), dst.path().join("planted")).unwrap();

        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let m = manifest.clone();
        let sender = tokio::spawn(async move {
            let _ =
                crate::transfer::send_transfer(&mut theirs, &m, &[Some(path.clone())], &[], |_| {})
                    .await;
        });
        let res = receive_transfer(&mut mine, dst.path(), |_| {}, None, |_| {}).await;
        sender.abort();

        assert!(
            matches!(res, Err(CoreError::Protocol(_))),
            "a symlinked INTERMEDIATE component must be refused before anything is created beneath it, got {res:?}"
        );
        assert!(
            !outside.path().join("deep/leaf.bin").exists(),
            "no byte may land outside out_dir"
        );
        assert!(
            !outside.path().join("deep").exists(),
            "nothing may be CREATED through the symlink either: the escape is a write primitive, not only a completed file"
        );
    }

    /// F3, cap half: a peer-supplied attrs["path"] may not name an unbounded
    /// number of directories.
    #[test]
    fn a_path_with_too_many_components_is_refused() {
        let out = Path::new("/tmp/out");
        let deep: Vec<String> = (0..MAX_PATH_COMPONENTS + 1)
            .map(|i| format!("d{i}"))
            .collect();
        let item = peer_item(0, &format!("{}/x.bin", deep.join("/")));
        let err = item_destination(out, &item).unwrap_err();
        assert!(matches!(err, CoreError::Protocol(_)), "got {err:?}");
        let msg = err.to_string();
        assert!(
            msg.contains("components") && msg.contains("item 0"),
            "the error must name the limit and the item, got: {msg}"
        );
    }

    /// F3, cap half: nor an unbounded joined length. 200 fat components clear
    /// the component cap and are still an absurd path.
    #[test]
    fn a_path_with_an_over_long_joined_length_is_refused() {
        let out = Path::new("/tmp/out");
        let fat: Vec<String> = (0..MAX_PATH_COMPONENTS).map(|_| "x".repeat(200)).collect();
        let item = peer_item(1, &format!("{}/x.bin", fat.join("/")));
        let err = item_destination(out, &item).unwrap_err();
        assert!(matches!(err, CoreError::Protocol(_)), "got {err:?}");
        assert!(
            err.to_string().contains("length"),
            "the error must name the length cap, got: {err}"
        );
    }

    /// The caps must not clip a real folder share: a 20-deep tree is a
    /// legitimate project directory.
    #[test]
    fn a_reasonable_depth_is_still_accepted() {
        let out = Path::new("/tmp/out");
        let deep: Vec<String> = (0..20).map(|i| format!("d{i}")).collect();
        let rel = format!("{}/x.bin", deep.join("/"));
        let dest = item_destination(out, &peer_item(0, &rel)).unwrap();
        assert!(dest.starts_with(out), "got {dest:?}");
        assert!(dest.ends_with("x.bin"), "got {dest:?}");
    }

    /// F4: two items claiming the SAME attrs["path"] both open the same file
    /// and write interleaved chunks into it. Reject in validate_manifest,
    /// before any byte is written and before any file is created.
    #[test]
    fn validate_manifest_rejects_two_items_with_the_same_relative_path() {
        let manifest = Manifest::new(
            PayloadKind::Batch,
            dev(),
            vec![
                peer_item(0, "same/place.bin"),
                peer_item(1, "same/place.bin"),
            ],
        );
        assert!(matches!(
            validate_manifest(&manifest),
            Err(CoreError::Protocol(m)) if m.contains("same") && m.contains("item 1")
        ));
    }

    /// Two DIFFERENT relative strings that sanitise to one destination are the
    /// same hazard, which is why the duplicate check keys on the RESOLVED
    /// destination and not on the raw text. `a/place.bin` and `./a//place.bin`
    /// are different strings and the same file.
    #[test]
    fn validate_manifest_rejects_two_paths_that_resolve_to_one_destination() {
        let out = Path::new("/tmp/out");
        let manifest = Manifest::new(
            PayloadKind::Batch,
            dev(),
            vec![peer_item(0, "a/place.bin"), peer_item(1, "./a//place.bin")],
        );
        assert_eq!(
            item_destination(out, &manifest.items[0]).unwrap(),
            item_destination(out, &manifest.items[1]).unwrap(),
            "this test only means something if they collide"
        );
        assert!(matches!(
            validate_manifest(&manifest),
            Err(CoreError::Protocol(_))
        ));
    }

    /// The dedup must key on the RESOLVED destination of EVERY binary item,
    /// not only on the ones carrying a Text attrs["path"]. A loose picked file
    /// deliberately has no attrs["path"] and resolves to out_dir/<safe name>,
    /// while a folder child resolves to out_dir/<sanitised path> -- the two
    /// resolution functions are separate, so comparing only the folder side
    /// leaves a cross-population collision invisible.
    #[test]
    fn validate_manifest_rejects_a_flat_item_colliding_with_a_path_item() {
        let flat = Item {
            index: 0,
            item_type: ItemType::Document,
            name: Some("x.bin".into()),
            size: Some(100),
            chunk_size: Some(CHUNK_SIZE_MIN),
            chunk_count: Some(1),
            ..Default::default()
        };
        // A folder child whose sanitised path lands on the same file.
        let mut carried = peer_item(1, "x.bin");
        carried.name = Some("x.bin~1".into());
        assert!(!flat.attrs.contains_key("path"));
        assert!(carried.attrs.contains_key("path"));
        let manifest = Manifest::new(PayloadKind::Batch, dev(), vec![flat, carried]);
        assert!(matches!(
            validate_manifest(&manifest),
            Err(CoreError::Protocol(m)) if m.contains("x.bin") && m.contains("item 1")
        ));
    }

    /// Same hole reached through a NON-Text attrs["path"]: `item_destination`
    /// falls back to the bare name for it, so it collides with a flat item too.
    #[test]
    fn validate_manifest_rejects_a_non_text_path_colliding_with_a_flat_item() {
        let mut odd = Item {
            index: 0,
            item_type: ItemType::Document,
            name: Some("y.bin".into()),
            size: Some(100),
            chunk_size: Some(CHUNK_SIZE_MIN),
            chunk_count: Some(1),
            ..Default::default()
        };
        odd.attrs
            .insert("path".into(), ciborium::value::Value::Integer(7.into()));
        let flat = Item {
            index: 1,
            item_type: ItemType::Document,
            name: Some("y.bin".into()),
            size: Some(100),
            chunk_size: Some(CHUNK_SIZE_MIN),
            chunk_count: Some(1),
            ..Default::default()
        };
        let manifest = Manifest::new(PayloadKind::Batch, dev(), vec![odd, flat]);
        assert!(matches!(
            validate_manifest(&manifest),
            Err(CoreError::Protocol(_))
        ));
    }

    /// The flat counterpart of the cross-population case above, kept for the
    /// same reason: a hand-built manifest with two items claiming one file is
    /// refused. Pre-B1 this shape was accepted and the second write
    /// overwrote the first, but no BUILDER produces it either (one `used` set
    /// for names, one `dests` set for destinations), so this pins the backstop
    /// against a hostile peer rather than a behaviour we rely on.
    #[test]
    fn validate_manifest_rejects_two_flat_items_with_the_same_name() {
        let mk = |index: u32| Item {
            index,
            item_type: ItemType::Document,
            name: Some("dup.bin".into()),
            size: Some(100),
            chunk_size: Some(CHUNK_SIZE_MIN),
            chunk_count: Some(1),
            ..Default::default()
        };
        let manifest = Manifest::new(PayloadKind::Batch, dev(), vec![mk(0), mk(1)]);
        assert!(matches!(
            validate_manifest(&manifest),
            Err(CoreError::Protocol(m)) if m.contains("dup.bin") && m.contains("item 1")
        ));
    }

    /// The backstop stays load-bearing against a peer that controls
    /// attrs["path"] outright, which is why this is hand-built rather than
    /// produced by the builder.
    #[tokio::test]
    async fn a_colliding_relative_path_writes_nothing() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let p0 = src.path().join("a.bin");
        let p1 = src.path().join("b.bin");
        std::fs::write(&p0, vec![1u8; 40_000]).unwrap();
        std::fs::write(&p1, vec![2u8; 40_000]).unwrap();

        let mut i0 = Item::from_file(0, &p0, 64 * 1024).unwrap();
        i0.attrs.insert(
            "path".into(),
            ciborium::value::Value::Text("same/place.bin".into()),
        );
        let mut i1 = Item::from_file(1, &p1, 64 * 1024).unwrap();
        i1.attrs.insert(
            "path".into(),
            ciborium::value::Value::Text("same/place.bin".into()),
        );
        let manifest = Manifest::new(PayloadKind::Batch, dev(), vec![i0, i1]);

        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let m = manifest.clone();
        // Only the manifest goes over the wire: there is no sender here to
        // assert on, because a builder-produced manifest cannot reach this.
        tokio::spawn(async move {
            let _ = theirs
                .send(
                    CONTROL_STREAM,
                    RecordType::Manifest,
                    Bytes::from(m.to_cbor().unwrap()),
                )
                .await;
        });
        let res = receive_transfer(&mut mine, dst.path(), |_| {}, None, |_| {}).await;

        assert!(matches!(res, Err(CoreError::Protocol(_))), "got {res:?}");
        assert!(
            !dst.path().join("same/place.bin").exists(),
            "the collision must be caught before any bytes are written"
        );
    }

    /// F3b: `staging` is the reserved outbound staging ROOT inside out_dir
    /// (engine.rs creates it there), holding live staged files for sends in
    /// flight, so a peer must not be able to name it.
    #[test]
    fn staging_is_a_reserved_component() {
        let out = Path::new("/tmp/out");
        let dest = item_destination(out, &peer_item(0, "staging/live.bin")).unwrap();
        assert!(
            !dest.starts_with(out.join("staging")),
            "staging must be remapped, got {dest:?}"
        );
        // The same name as a LEAF is reserved too, not just as a directory.
        let dest = item_destination(out, &peer_item(0, "sub/staging")).unwrap();
        assert_ne!(dest, out.join("sub/staging"), "got {dest:?}");
        // An item whose bare NAME is `staging` must not land there either.
        let mut item = peer_item(0, "x");
        item.name = Some("staging".into());
        assert_ne!(item_output_path(out, &item).unwrap(), out.join("staging"));
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
        let res = receive_transfer(&mut conn, dst.path(), |_| {}, None, |_| {}).await;
        sender.await.unwrap();
        assert!(matches!(res, Err(crate::CoreError::Protocol(_))));
    }

    /// A chunk longer than the item's chunk size would overwrite its neighbours
    /// and grow the file past the declared size.
    #[tokio::test]
    async fn rejects_a_chunk_longer_than_the_chunk_size_without_writing() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let path = src.path().join("l.bin");
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
            let body = encode_chunk_body(0, 0, &vec![1u8; 70_000]);
            conn.send(100, RecordType::Chunk, Bytes::from(body))
                .await
                .unwrap();
        });

        let mut conn = tcp::dial(addr).await.unwrap();
        let res = receive_transfer(&mut conn, dst.path(), |_| {}, None, |_| {}).await;
        sender.await.unwrap();
        assert!(
            matches!(res, Err(crate::CoreError::Protocol(_))),
            "got {res:?}"
        );
        assert_eq!(
            std::fs::metadata(dst.path().join("l.bin"))
                .map(|m| m.len())
                .unwrap_or(0),
            0,
            "no bytes may be written for an over-long chunk"
        );
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
        let res = receive_transfer(&mut conn, dst.path(), |_| {}, None, |_| {}).await;
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
        receive_transfer(&mut conn, dst.path(), |_| {}, None, |_| {})
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
        let res = receive_transfer(&mut conn, dst.path(), |_| {}, None, |_| {}).await;
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
        let mut second = Item::from_file(1, &path, 64 * 1024).unwrap();
        // Distinct destination: this test is about the INDEX check. Two binary
        // items resolving to one file are a separate rejection (see
        // validate_manifest_rejects_two_flat_items_with_the_same_name), so both
        // items were built from the same file on purpose and the second is
        // renamed to give it its own destination -- otherwise this test would
        // be testing the duplicate rule by accident.
        second.name = Some("b.bin".into());
        let items = vec![Item::from_file(0, &path, 64 * 1024).unwrap(), second];
        let manifest = Manifest::new(PayloadKind::Media, dev(), items);
        validate_manifest(&manifest).unwrap();
    }
}
