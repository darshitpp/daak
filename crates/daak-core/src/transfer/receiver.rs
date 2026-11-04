use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::chunk::ChunkBitmap;
use crate::control::{AckMsg, ResumeMsg};
use crate::engine::EngineEvent;
use crate::error::{ensure_compatible, CoreError, Result};
use crate::framing::RecordType;
use crate::hash::blake2b256_reader;
use crate::manifest::{Item, Manifest, CHUNK_SIZE_MAX, CHUNK_SIZE_MIN};
use crate::net::{FrameTransport, CONTROL_STREAM};
use crate::store::transfers::{dest_key, ItemRow, TransferRow};
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
/// The cap on the bytes of every attrs["path"] in one manifest together. The
/// receiver stores the paths in the destination list and in the item rows.
/// A total at or below the cap passes. 65 536 items with a 256-byte path give
/// a total equal to the cap, so they pass.
const MAX_TOTAL_PATH_BYTES: usize = 16 * 1024 * 1024;

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

/// The largest suffix the receiver gives to one name. Past it the transfer
/// fails. The cap bounds the work for a hostile manifest.
const SUFFIX_MAX: u32 = 10_000;

/// Create `name` in `parent` as a new file or a new directory, and return its
/// path. F4: the file system decides what exists. A file is created with
/// `create_new` and a directory with `create_dir`. Neither follows a symlink,
/// and neither opens an existing file. On `AlreadyExists` the name takes the
/// next suffix `-N`.
///
/// `next` holds the next suffix for each name, so a manifest of 65 536 items
/// on one name costs linear time. The key is lower case. Then the case
/// variants of one name share one counter on a case-insensitive file system.
/// The key only selects the first suffix to try. The file system decides
/// what is free.
///
/// `created` gets each path that this call creates, so a failed receive can
/// remove what it made.
///
/// The error text names the item index only. A path holds a user file name.
fn create_free(
    parent: &Path,
    name: &str,
    is_dir: bool,
    next: &mut HashMap<String, u32>,
    index: u32,
    created: &mut Vec<PathBuf>,
) -> Result<PathBuf> {
    let make = |path: &Path| {
        if is_dir {
            std::fs::create_dir(path)
        } else {
            // The file closes at once. No handle stays open for each item.
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .map(drop)
        }
    };
    let plain = parent.join(name);
    match make(&plain) {
        Ok(()) => {
            created.push(plain.clone());
            return Ok(plain);
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.into()),
    }
    let n = next
        .entry(plain.to_string_lossy().to_lowercase())
        .or_insert(1);
    while *n <= SUFFIX_MAX {
        let candidate = parent.join(crate::manifest::suffixed(name, *n, is_dir));
        *n += 1;
        match make(&candidate) {
            Ok(()) => {
                created.push(candidate.clone());
                return Ok(candidate);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
    }
    Err(CoreError::Transfer(format!(
        "item {index} has no free destination name"
    )))
}

/// Choose and create the destination of one binary item, below `root`. F4:
/// the receiver never refuses an item for a name that exists.
///
/// `dirs` maps each directory of the manifest path to the real directory.
/// The first component is the group root. The receiver creates each
/// directory once, with `create_dir`. A folder that exists makes the whole
/// group take the suffix (`album-1`). The receiver does not merge into it.
/// Later items of the group read the real directory from `dirs`.
///
/// The file is created empty and closed. An empty item gets no chunk, so the
/// verify step needs the file. `created` gets each new folder and the file.
fn allocate_destination(
    root: &Path,
    item: &Item,
    dirs: &mut HashMap<PathBuf, PathBuf>,
    next: &mut HashMap<String, u32>,
    created: &mut Vec<PathBuf>,
) -> Result<PathBuf> {
    let logical = item_destination(root, item)?;
    let rel = logical.strip_prefix(root).map_err(|_| {
        CoreError::Protocol(format!(
            "item {} destination is outside the output directory",
            item.index
        ))
    })?;
    let parts: Vec<String> = rel
        .iter()
        .map(|c| c.to_string_lossy().into_owned())
        .collect();
    let Some((leaf, folders)) = parts.split_last() else {
        return Err(CoreError::Protocol(format!(
            "item {} has no destination name",
            item.index
        )));
    };
    let mut parent = root.to_path_buf();
    let mut key = PathBuf::new();
    for folder in folders {
        key.push(folder);
        parent = match dirs.get(&key) {
            Some(real) => real.clone(),
            None => {
                let real = create_free(&parent, folder, true, next, item.index, created)?;
                dirs.insert(key.clone(), real.clone());
                real
            }
        };
    }
    create_free(&parent, leaf, false, next, item.index, created)
}

/// Remove the paths that this receive created, newest first, so a file goes
/// before its folder. F4: a failed allocation leaves no folder behind. Then
/// a retry does not make `album-1`, `album-2`, and more. Each path is one
/// that this receive created, so the removal cannot touch a user file.
fn remove_created(created: &[PathBuf]) {
    for path in created.iter().rev() {
        let removed = match std::fs::symlink_metadata(path) {
            Ok(m) if m.is_dir() => std::fs::remove_dir(path),
            Ok(_) => std::fs::remove_file(path),
            Err(e) => Err(e),
        };
        if let Err(e) = removed {
            tracing::warn!(error = %e, "a created destination was not removed");
        }
    }
}

/// Check the directory chain from `root` to `parent`. Create nothing. F2: the
/// receiver runs this check before each chunk write, so a directory that
/// became a symlink after the allocation is found.
///
/// F3: every component must be a real directory, not a symlink. A missing
/// component is an error. The receiver does not create a directory at chunk
/// time.
///
/// NOT canonicalise-and-recompare: on macOS /var and /private/var are one
/// directory under two names, so comparing canonical forms would reject every
/// honest receive into a tempdir.
///
/// Residual race, accepted: a component can change between this check and the
/// open. The attacker would already need write access to out_dir.
///
/// The error text names no path. A path holds a user file or folder name.
fn check_real_dir_chain(root: &Path, parent: &Path) -> Result<()> {
    let rel = parent.strip_prefix(root).map_err(|_| {
        CoreError::Protocol("a chunk destination is outside the output directory".into())
    })?;
    let mut dir = root.to_path_buf();
    for component in rel.components() {
        dir.push(component);
        match std::fs::symlink_metadata(&dir) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(CoreError::Protocol(
                    "a chunk destination traverses a symlink".into(),
                ));
            }
            Ok(m) if !m.is_dir() => {
                return Err(CoreError::Protocol(
                    "a chunk destination is blocked by a non-directory".into(),
                ));
            }
            Ok(_) => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

/// Write one chunk into the item file at `path`. F2: the receiver keeps no
/// handle for each item. Each chunk opens the file, seeks, writes, flushes,
/// and closes it, in one blocking task.
///
/// The open does not create the file. A missing file is an error, and the
/// transfer can resume. On unix `O_NOFOLLOW` refuses a symlink at the last
/// component.
async fn write_chunk(root: &Path, path: &Path, offset: u64, data: &[u8]) -> Result<()> {
    use std::io::{Seek, Write};
    let (root, path, data) = (root.to_path_buf(), path.to_path_buf(), data.to_vec());
    tokio::task::spawn_blocking(move || -> Result<()> {
        if let Some(parent) = path.parent() {
            check_real_dir_chain(&root, parent)?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(false).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options.open(&path)?;
        file.seek(std::io::SeekFrom::Start(offset))?;
        file.write_all(&data)?;
        file.flush()?;
        Ok(())
    })
    .await
    .map_err(|e| CoreError::Transfer(format!("chunk write task failed: {e}")))?
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
    // The sum of the path lengths is capped, so one manifest cannot hold
    // 65 536 paths of 4 096 bytes. The message holds no name.
    let path_bytes: usize = manifest
        .items
        .iter()
        .filter_map(|i| match i.attrs.get("path") {
            Some(ciborium::value::Value::Text(p)) => Some(p.len()),
            _ => None,
        })
        .sum();
    if path_bytes > MAX_TOTAL_PATH_BYTES {
        return Err(CoreError::Protocol(format!(
            "manifest paths hold {path_bytes} bytes, above the cap {MAX_TOTAL_PATH_BYTES}"
        )));
    }
    // F7: a group item must carry a path that starts with its group. The
    // notification and the move step read the root folder from the path, not
    // from the group value. A mismatch makes them name the wrong folder. An
    // item with no group is unchanged. The message holds no name.
    for item in &manifest.items {
        let Some(group) = item.attrs.get("group") else {
            continue;
        };
        let group_ok = match group {
            ciborium::value::Value::Text(g) => {
                !g.is_empty() && !g.contains('/') && !g.contains('\\')
            }
            _ => false,
        };
        let path_ok = match (group, item.attrs.get("path")) {
            (ciborium::value::Value::Text(g), Some(ciborium::value::Value::Text(p))) => p
                .strip_prefix(g.as_str())
                .is_some_and(|rest| rest.starts_with('/')),
            _ => false,
        };
        if !group_ok || !path_ok {
            return Err(CoreError::Protocol(format!(
                "item {} has a group that does not match its path",
                item.index
            )));
        }
    }
    Ok(())
}

/// `path` relative to `root`, with `/` between the components. The stored
/// list holds this form.
fn relative_dest(root: &Path, path: &Path) -> Result<String> {
    let rel = path
        .strip_prefix(root)
        .map_err(|_| CoreError::Protocol("a destination is outside the output directory".into()))?;
    let parts: Vec<String> = rel
        .iter()
        .map(|c| c.to_string_lossy().into_owned())
        .collect();
    Ok(parts.join("/"))
}

/// The stored destinations of this payload, one for each binary item, or
/// `None` when the payload starts fresh. F4: the list is a hint from this
/// device. Each path runs through `safe_components` again and must stay under
/// `root`. The file of an open item must still exist as a regular file. A
/// `recreate` item needs only its folder, because it gets a new file. A
/// settled item needs nothing, because the platform can move its file. Any
/// failed check starts the whole payload fresh.
fn stored_dests(
    bytes: Option<Vec<u8>>,
    manifest: &Manifest,
    root: &Path,
    settled: &HashSet<u32>,
    recreate: &HashSet<u32>,
) -> Option<Vec<PathBuf>> {
    let list = ciborium::from_reader::<Vec<String>, _>(bytes?.as_slice()).ok()?;
    if list.len() != manifest.binary_items().count() {
        return None;
    }
    let mut out = Vec::with_capacity(list.len());
    for (item, rel) in manifest.binary_items().zip(&list) {
        let parts = safe_components(rel, item.index).ok()?;
        // The sanitised form must be the stored text. Then the text holds no
        // traversal, no absolute path, and no reserved name.
        if parts.is_empty() || parts.join("/") != *rel {
            return None;
        }
        let path = parts.iter().fold(root.to_path_buf(), |p, c| p.join(c));
        if !path.starts_with(root) {
            return None;
        }
        let parent = path.parent().unwrap_or(root);
        let usable = if settled.contains(&item.index) {
            true
        } else if recreate.contains(&item.index) {
            check_real_dir_chain(root, parent).is_ok()
        } else {
            check_real_dir_chain(root, parent).is_ok()
                && std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_file())
        };
        if !usable {
            return None;
        }
        out.push(path);
    }
    Some(out)
}

/// The destination that the allocation chose for item `index`.
fn dest_of(dests: &[Option<PathBuf>], index: u32) -> Result<&Path> {
    dests
        .get(index as usize)
        .and_then(|d| d.as_deref())
        .ok_or_else(|| CoreError::Protocol(format!("item {index} has no destination")))
}

/// The bytes a receive already holds on disk, from the loaded bitmaps. A fresh
/// receive has empty bitmaps, so this is 0 -- the progress bar must NOT start
/// one chunk ahead (P6 3.2). Every held chunk counts a full chunk length, except
/// the LAST chunk of an item, which can be partial and counts its real length.
fn bytes_held(manifest: &Manifest, bitmaps: &[Option<ChunkBitmap>]) -> u64 {
    manifest
        .binary_items()
        .filter_map(|i| {
            let bm = bitmaps.get(i.index as usize).and_then(|b| b.as_ref())?;
            let chunk_size = i.chunk_size? as u64;
            let size = i.size?;
            let held = bm.count_ones();
            let chunk_count = size.div_ceil(chunk_size.max(1));
            // The last chunk is short when the item size is not a chunk
            // multiple: size - (chunk_count - 1) * chunk_size. A held last
            // chunk counts that length, not a full chunk.
            let last_set = chunk_count > 0 && bm.is_set(chunk_count - 1);
            let last_len = size - (chunk_count.saturating_sub(1)).saturating_mul(chunk_size);
            let bytes = held.saturating_sub(u64::from(last_set)) * chunk_size
                + if last_set { last_len } else { 0 };
            Some(bytes.min(size))
        })
        .sum()
}

pub async fn receive_transfer<T: FrameTransport>(
    conn: &mut T,
    out_dir: &Path,
    mut on_progress: impl FnMut(u64),
    db: Option<&Db>,
    on_item: impl FnMut(EngineEvent),
) -> Result<Manifest> {
    receive_transfer_from(
        conn,
        None,
        out_dir,
        |_, n, _, _, _| on_progress(n),
        db,
        on_item,
    )
    .await
}

/// Like `receive_transfer`. With `Some(id)`, the manifest must name `id` as its
/// sender. The caller passes the device id of the authenticated peer.
#[tracing::instrument(
    name = "receive",
    skip_all,
    fields(
        peer = tracing::field::Empty,
        payload = tracing::field::Empty,
        bytes = tracing::field::Empty
    )
)]
pub async fn receive_transfer_from<T: FrameTransport>(
    conn: &mut T,
    expected_sender: Option<[u8; 16]>,
    out_dir: &Path,
    // (payload id, chunk length, bytes total). The receiver knows the id and
    // the total only after it parses the manifest, so both travel with each
    // progress call (P4 Task 12).
    // (payload id, new chunk bytes, bytes total, bytes the receiver already
    // HOLDS from a prior attempt, credited). `credited` is false for a
    // duplicate payload (payload_seen): the bytes go to the discard directory
    // and no row is written, so the caller must write no bytes_done and send
    // no event (P6 3.1). `initial` lets a resume that skips chunks start its
    // bar from the held bytes, so it reaches 100% (P6 3.2).
    on_progress: impl FnMut([u8; 16], u64, u64, u64, bool),
    db: Option<&Db>,
    on_item: impl FnMut(EngineEvent),
) -> Result<Manifest> {
    receive_with_resume_limit(
        conn,
        expected_sender,
        out_dir,
        on_progress,
        db,
        on_item,
        RESUME_MSG_MAX,
    )
    .await
}

/// The largest encoded `ResumeMsg` that the receiver sends. A version 100
/// sender, or a sender that does not know the peer version, does not read
/// while it streams. A message larger than both socket buffers then blocks
/// both sides, and no frame deadline ends it. A message at or below this size
/// fits in the socket buffers.
const RESUME_MSG_MAX: usize = 64 * 1024;

/// The encoded `ResumeMsg`, or `None` when it is larger than `limit`. With
/// `None`, the receiver sends no message. A version 101 sender then waits for
/// `RESUME_WAIT` and sends every chunk.
fn resume_frame(msg: &ResumeMsg, limit: usize) -> Result<Option<Vec<u8>>> {
    let bytes = msg.to_cbor()?;
    Ok((bytes.len() <= limit).then_some(bytes))
}

/// `receive_transfer_from` with the `ResumeMsg` size limit as a parameter, so
/// a test can use a small limit.
async fn receive_with_resume_limit<T: FrameTransport>(
    conn: &mut T,
    expected_sender: Option<[u8; 16]>,
    out_dir: &Path,
    mut on_progress: impl FnMut([u8; 16], u64, u64, u64, bool),
    db: Option<&Db>,
    mut on_item: impl FnMut(EngineEvent),
    resume_limit: usize,
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
    let span = tracing::Span::current();
    if let Some(id) = expected_sender {
        span.record("peer", tracing::field::display(crate::diag::short_id(&id)));
    }
    span.record(
        "payload",
        tracing::field::display(crate::diag::short_id(&manifest.payload_id)),
    );
    if expected_sender.is_some_and(|id| id != manifest.sender.device_id) {
        return Err(CoreError::Protocol(
            "manifest sender is not the authenticated peer".into(),
        ));
    }

    // One sum for the row and for the progress events. A non-binary item is
    // never materialised, so its size must not count (B2).
    let bytes_total: u64 = manifest.binary_items().filter_map(|i| i.size).sum();
    span.record("bytes", bytes_total);

    // D23: a re-delivery of a payload_id that is already in the inbox must not
    // write into the real destination. A half-written duplicate would truncate
    // the first good copy. Every item write goes to a discard directory
    // instead, and the sender still gets its Ack so it stops re-sending. The
    // guard removes the directory on every return path.
    //
    // Resume (version 101): the item rows of an EARLIER receive of this
    // payload. A `done` item is settled: the receiver asks for none of its
    // chunks and does not touch its file, because the platform can have moved
    // it. A `quarantined` or `failed` item is received again in full. While
    // such an item exists, the payload is not a duplicate.
    let mut earlier: Vec<ItemRow> = match db {
        Some(db) => db.list_items(&manifest.payload_id)?,
        None => Vec::new(),
    };
    // Sets, not lists: the receiver looks up each item and each chunk, and a
    // folder can hold 65 536 items.
    let mut redo: HashSet<u32> = earlier
        .iter()
        .filter(|r| r.state == "quarantined" || r.state == "failed")
        .map(|r| r.item_index)
        .collect();
    let dedupe = match db {
        Some(db) => redo.is_empty() && db.payload_seen(&manifest.payload_id)?,
        None => false,
    };
    // F9: the stored state of a payload describes the stored manifest only.
    // A changed manifest under the same payload id starts fresh. Both byte
    // strings are re-encodes by this receiver, and they hold the sender.
    // Only an inbound row starts fresh. An outbound row of this device with
    // the same id keeps its state.
    let kind = format!("{:?}", manifest.kind).to_lowercase();
    let encoded = manifest.to_cbor()?;
    // An earlier receive of this payload that ran to its end. Then a file at
    // a stored path is not a partial of this payload.
    let mut prior_done = false;
    if let Some(db) = db.filter(|_| !dedupe) {
        let stored = db.get_transfer(&manifest.payload_id)?;
        prior_done = stored
            .as_ref()
            .is_some_and(|t| t.direction == "in" && t.state == "done");
        if stored.is_some_and(|t| t.direction == "in" && t.manifest != encoded) {
            db.fresh_start(
                &manifest.payload_id,
                &manifest.payload_id,
                &manifest.sender.device_id,
                &kind,
                manifest.items.len() as u32,
                &encoded,
            )?;
            earlier.clear();
            redo.clear();
            prior_done = false;
        }
    }
    // F4: the stored destinations, read once here. After a receive that ran
    // to its end, the list is deleted from the db BEFORE this attempt writes
    // the `active` row. A crash or a failed allocation then leaves no list.
    // The next attempt sees `active`, not `done`, so without this delete it
    // would treat a file of the user at a stored path as a partial. This
    // attempt uses the list from memory and writes it again after its
    // creates.
    let stored_list: Option<Vec<u8>> = match db.filter(|_| !dedupe) {
        Some(db) => {
            let key = dest_key(&manifest.payload_id);
            let bytes = db.get_setting(&key)?;
            if prior_done && bytes.is_some() {
                db.delete_setting(&key)?;
            }
            bytes
        }
        None => None,
    };
    // A duplicate settles nothing. It writes every chunk into the discard
    // directory, as before, so an old sender that sends all chunks completes.
    let settled: HashSet<u32> = if dedupe {
        HashSet::new()
    } else {
        earlier
            .iter()
            .filter(|r| r.state == "done")
            .map(|r| r.item_index)
            .collect()
    };
    let is_settled = |index: u32| settled.contains(&index);
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
            kind: kind.clone(),
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
            manifest: encoded.clone(),
            error: None,
        })?;
    }
    let capacity = manifest.items.len().min(MAX_ITEMS);
    // F4: one destination for each binary item, chosen once here. Every later
    // use of an item path reads this list.
    let mut dests: Vec<Option<PathBuf>> = Vec::with_capacity(capacity);
    let mut dirs: HashMap<PathBuf, PathBuf> = HashMap::new();
    let mut next_suffix: HashMap<String, u32> = HashMap::new();
    let mut bitmaps: Vec<Option<ChunkBitmap>> = Vec::with_capacity(capacity);
    let mut total_chunks: u64 = 0;
    for item in &manifest.items {
        if !item.is_binary() {
            dests.push(None);
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
        dests.push(None);
        bitmaps.push(None);
    }

    // F4: the items that get a NEW file, also when a stored path exists: a
    // redo item, and every open item after a receive that ran to its end. An
    // open item there has no row, because the user deleted its held copy. A
    // file at its stored path is then not a partial of this payload, so the
    // receiver must not write into it.
    let recreate: HashSet<u32> = if prior_done {
        manifest
            .binary_items()
            .map(|i| i.index)
            .filter(|i| !is_settled(*i))
            .collect()
    } else {
        redo.clone()
    };
    // F4: the destinations that an earlier attempt of this payload chose. A
    // resume reuses them, so a partial file does not take a suffix. With no
    // usable list, every open item gets a new file.
    let store = db.filter(|_| !dedupe);
    let stored =
        store.and_then(|_| stored_dests(stored_list, &manifest, &dest_root, &settled, &recreate));
    let mut list: Vec<String> = Vec::new();
    // Every path that this attempt creates. An error below removes them.
    let mut created: Vec<PathBuf> = Vec::new();
    let allocated = (|| -> Result<()> {
        for (k, item) in manifest.binary_items().enumerate() {
            let chunk_count = item.chunk_count.unwrap_or(0);
            let reused = stored.as_ref().map(|s| &s[k]);
            let dest = if is_settled(item.index) {
                // A settled item keeps its file and gets no chunk.
                None
            } else if let Some(path) = reused.filter(|_| !recreate.contains(&item.index)) {
                // B1/R-T7-5: the file holds the chunks of the earlier attempt,
                // and the stored bitmap names them. The bitmap is a HINT. The
                // per-item hash at the end decides done or quarantined.
                let db = store.expect("a stored list needs a db");
                bitmaps[item.index as usize] =
                    Some(db.load_bitmap(&manifest.payload_id, item.index, chunk_count)?);
                Some(path.clone())
            } else {
                let path = match reused {
                    // A new file at the stored path. A redo item: the
                    // quarantine moved its file away. A file that is there
                    // now is not ours, so the item takes a suffix.
                    Some(path) => {
                        let parent = path.parent().unwrap_or(&dest_root);
                        let leaf = path
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_default();
                        create_free(
                            parent,
                            &leaf,
                            false,
                            &mut next_suffix,
                            item.index,
                            &mut created,
                        )?
                    }
                    // B1: a folder's children arrive in subdirectories that
                    // do not exist yet. The allocation creates them and the
                    // file.
                    None => allocate_destination(
                        &dest_root,
                        item,
                        &mut dirs,
                        &mut next_suffix,
                        &mut created,
                    )?,
                };
                // A new empty file holds no chunk, so a stored bitmap goes.
                if let Some(db) = store {
                    db.clear_bitmap(&manifest.payload_id, item.index)?;
                }
                bitmaps[item.index as usize] = Some(ChunkBitmap::new(chunk_count));
                Some(path)
            };
            let entry = match (&dest, reused) {
                (Some(path), _) | (None, Some(path)) => path.clone(),
                (None, None) => item_destination(&dest_root, item)?,
            };
            list.push(relative_dest(&dest_root, &entry)?);
            dests[item.index as usize] = dest;
        }
        // One write after every create. A crash before it leaves the list of
        // an interrupted receive as it was: each path in it is still a
        // partial of this payload. After a receive that ran to its end, the
        // list is already deleted (see `stored_list`), so a crash leaves no
        // list, and the next attempt starts the payload fresh.
        if let Some(db) = store {
            let mut bytes = Vec::new();
            ciborium::into_writer(&list, &mut bytes)
                .map_err(|e| CoreError::Cbor(format!("destination list: {e}")))?;
            db.set_setting(&dest_key(&manifest.payload_id), &bytes)?;
        }
        Ok(())
    })();
    if let Err(e) = allocated {
        remove_created(&created);
        return Err(e);
    }

    // Version 101: tell the sender which chunks this receiver still needs. A
    // version 100 sender skips the frame. A send failure is not fatal here:
    // the peer can have closed after its last chunk, and the frames that it
    // sent are still in the buffer. The receive loop below reads them.
    let resume = ResumeMsg {
        transfer_id: manifest.payload_id,
        ranges: bitmaps
            .iter()
            .map(|b| b.as_ref().map(super::gaps_to_nack).unwrap_or_default())
            .collect(),
    };
    // A message above the limit is not sent (see RESUME_MSG_MAX). The receive
    // loop below accepts every chunk in both cases. It ignores only the chunks
    // of a settled item.
    match resume_frame(&resume, resume_limit)? {
        Some(frame) => {
            if let Err(e) = conn
                .send(CONTROL_STREAM, RecordType::Nack, bytes::Bytes::from(frame))
                .await
            {
                tracing::warn!(error = %crate::diag::log_err(&e), "resume message not sent");
            }
        }
        None => tracing::info!(
            items = manifest.items.len(),
            "resume message too large; the sender sends every chunk"
        ),
    }

    // The bytes a resume already holds: one chunk length for each bit the
    // persisted bitmap has set, capped at the item size. Zero for a fresh
    // receive, so the bar does not start one chunk ahead (P6 3.2).
    // A settled item counts in full.
    let bytes_held = bytes_held(&manifest, &bitmaps)
        + manifest
            .binary_items()
            .filter(|i| is_settled(i.index))
            .filter_map(|i| i.size)
            .sum::<u64>();

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
        // With a Db, a reset connection is an interrupt, the same as a close.
        // The bitmap is saved in both cases, so the next connection resumes.
        let frame = match conn.recv().await {
            Ok(Some(f)) => f,
            Ok(None) | Err(CoreError::Io(_)) if db.is_some() => {
                // `received_any` stays false for a duplicate, so a duplicate
                // saves no bitmap.
                if let Some(db) = db.filter(|_| received_any) {
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
            Ok(None) => return Err(CoreError::Protocol("closed mid-transfer".into())),
            Err(e) => return Err(e),
        };
        if frame.kind != RecordType::Chunk {
            continue;
        }
        let (item_index, chunk_index, data) = decode_chunk_body(&frame.body)?;
        // A version 100 sender sends every chunk, also for a settled item.
        // The receiver ignores those chunks.
        if is_settled(item_index) {
            continue;
        }
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

        let path = dests
            .get(idx)
            .and_then(|d| d.as_deref())
            .ok_or_else(|| CoreError::Protocol(format!("chunk for unknown item {item_index}")))?;
        write_chunk(&dest_root, path, offset, &data).await?;
        let bitmap = bitmaps[idx].as_mut().ok_or_else(|| {
            CoreError::Protocol(format!("chunk for non-binary item {item_index}"))
        })?;
        // T5: a chunk whose bit is already set re-writes bytes the receiver
        // already HOLDS. The engine seeded the bar with those bytes, so crediting
        // them again would count them twice and reach 100% before the last byte.
        let already_held = bitmap.is_set(chunk_index);
        on_progress(
            manifest.payload_id,
            data.len() as u64,
            bytes_total,
            bytes_held,
            !dedupe && !already_held,
        );
        if !bitmap.set(chunk_index) {
            return Err(CoreError::Protocol(format!(
                "chunk index {chunk_index} out of range for item {item_index}"
            )));
        }
        if let Some(db) = db.filter(|_| !dedupe) {
            received_any = true;
            chunks_since_persist += 1;
            if chunks_since_persist >= BITMAP_PERSIST_INTERVAL {
                // R-T7-5: keyed by manifest.payload_id (see above).
                db.save_bitmap(&manifest.payload_id, item_index, bitmap)?;
                chunks_since_persist = 0;
            }
        }
    }

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
    let mut failed: HashSet<u32> = HashSet::new();
    let mut held_paths: HashMap<u32, PathBuf> = HashMap::new();
    for item in manifest.binary_items().filter(|i| !is_settled(i.index)) {
        let path = dest_of(&dests, item.index)?;
        let f = std::fs::File::open(path)?;
        let actual = blake2b256_reader(f)?;
        if Some(actual) == item.hash {
            continue;
        }
        hash_ok = false;
        if failed_item.is_none() {
            failed_item = Some(item.index);
        }
        failed.insert(item.index);
        if db.is_some() {
            // I-4: a rename failure unrelated to corruption (ENOTDIR,
            // cross-device, read-only out dir) must not take down the whole
            // transfer after every byte already landed.
            match quarantine.hold(&manifest.payload_id, &safe_item_name(item), path) {
                Ok(held) => {
                    held_paths.insert(item.index, held);
                }
                Err(e) => tracing::warn!(
                    item = item.index,
                    error = %crate::diag::log_err(&e),
                    "quarantine hold failed; item stays at its final path"
                ),
            }
        }
    }

    // R-T12-6: persist the item rows (and the final transfer state) so a
    // quarantined item is reachable by retry_item / the UI.
    if let Some(db) = db.filter(|_| !dedupe) {
        // The held path of each item that an earlier receive quarantined.
        let held_before: HashMap<u32, &str> = earlier
            .iter()
            .filter(|r| r.state == "quarantined")
            .filter_map(|r| Some((r.item_index, r.dest_path.as_deref()?)))
            .collect();
        let mut bytes_done = 0u64;
        for item in &manifest.items {
            // A settled item keeps its row from the earlier receive.
            if is_settled(item.index) {
                if item.is_binary() {
                    bytes_done += item.size.unwrap_or(0);
                }
                continue;
            }
            let quarantined = failed.contains(&item.index);
            // Computed ONCE and used for BOTH the row and the event below, so
            // the two can never name two different files.
            //
            // Non-binary items are never materialised, so a dest_path for them
            // would point at a file that can never exist.
            let dest_path: Option<String> = if !item.is_binary() {
                None
            } else {
                let dest = match held_paths.get(&item.index) {
                    Some(p) => p.clone(),
                    None => dest_of(&dests, item.index)?.to_path_buf(),
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
            // A re-send repaired a held file, so the held copy goes. The path
            // comes from this device's own row. It must still be inside the
            // quarantine root.
            let held = held_before
                .get(&item.index)
                .copied()
                .map(Path::new)
                .filter(|p| !quarantined && p.starts_with(dest_root.join("quarantine")));
            if let Some(held) = held {
                if let Err(e) = std::fs::remove_file(held) {
                    tracing::warn!(item = item.index, error = %e, "held copy not removed");
                }
                // The slot directory goes when it is empty. Else it stays.
                if let Some(dir) = held.parent() {
                    let _ = std::fs::remove_dir(dir);
                }
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
        // F4: every item is done, so no resume and no redo follows. A held
        // item keeps the list, so its retry lands at the same path.
        if failed.is_empty() {
            db.delete_setting(&dest_key(&manifest.payload_id))?;
        }
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
            let good = dest_of(&dests, item.index)?;
            let dest = quarantine.slot(&manifest.payload_id, &safe_item_name(item));
            if let Some(dir) = dest.parent() {
                let _ = tokio::fs::create_dir_all(dir).await;
            }
            let _ = tokio::fs::rename(good, &dest).await;
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
    use crate::engine::{EngineEvent, ProgressGate, PROGRESS_INTERVAL};
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

    fn binary_manifest(size: u64, chunk_size: u32, chunk_count: u64) -> Manifest {
        let item = Item {
            index: 0,
            item_type: ItemType::Document,
            name: Some("a.bin".into()),
            size: Some(size),
            chunk_size: Some(chunk_size),
            chunk_count: Some(chunk_count),
            ..Default::default()
        };
        Manifest::new(PayloadKind::Media, dev(), vec![item])
    }

    /// The largest manifest (65 536 binary items of one chunk each) gives a
    /// `ResumeMsg` above `RESUME_MSG_MAX`. The receiver does not send it. A
    /// small manifest still gets its full-range message.
    #[test]
    fn a_resume_message_above_the_limit_is_not_sent() {
        let big = ResumeMsg {
            transfer_id: [1u8; 16],
            ranges: (0..MAX_ITEMS).map(|_| vec![(0u64, 1u64)]).collect(),
        };
        assert!(big.to_cbor().unwrap().len() > RESUME_MSG_MAX);
        assert_eq!(resume_frame(&big, RESUME_MSG_MAX).unwrap(), None);

        let small = ResumeMsg {
            transfer_id: [1u8; 16],
            ranges: vec![vec![(0, 4)]; 100],
        };
        let frame = resume_frame(&small, RESUME_MSG_MAX).unwrap().unwrap();
        assert_eq!(ResumeMsg::from_cbor(&frame).unwrap(), small);
    }

    /// A sender pair over a byte pipe with small buffers. The manifest has
    /// 2 000 text items and one binary item of 256 KiB, so its `ResumeMsg` is
    /// larger than the 1 KiB pipe buffer. `limit` is the receiver's resume
    /// limit. `wait` is `None` for a version 100 sender, which does not read
    /// while it streams.
    async fn receive_over_a_small_pipe(limit: usize, wait: Option<std::time::Duration>) {
        use crate::net::Connection;
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("big.bin");
        let bytes: Vec<u8> = (0..256 * 1024u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&src, &bytes).unwrap();
        let mut items: Vec<Item> = (0..2000u32).map(|i| Item::text(i, "")).collect();
        items.push(Item::from_file(2000, &src, CHUNK_SIZE_MIN).unwrap());
        let manifest = Manifest::new(PayloadKind::Batch, dev(), items);
        let mut paths: Vec<Option<PathBuf>> = vec![None; 2000];
        paths.push(Some(src.clone()));

        let (a, b) = tokio::io::duplex(1024);
        let mut tx = Connection::new(a, crate::framing::DEFAULT_MAX_FRAME);
        let mut rx = Connection::new(b, crate::framing::DEFAULT_MAX_FRAME);
        let m = manifest.clone();
        let sender = tokio::spawn(async move {
            match wait {
                None => crate::transfer::send_transfer(&mut tx, &m, &paths, &[], |_| {}).await,
                Some(w) => {
                    crate::transfer::send_transfer_resuming(&mut tx, &m, &paths, Some(w), |_| {})
                        .await
                }
            }
        });
        let out = dir.path().join("out");
        let received = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            receive_with_resume_limit(&mut rx, None, &out, |_, _, _, _, _| {}, None, |_| {}, limit),
        )
        .await
        .expect("the receive must not hang");
        received.unwrap();
        sender.await.unwrap().unwrap();
        assert_eq!(std::fs::read(out.join("big.bin")).unwrap(), bytes);
    }

    /// A version 100 sender streams and does not read. A large `ResumeMsg`
    /// then blocks both sides. Above the limit the receiver sends no message,
    /// so the transfer completes.
    #[tokio::test]
    async fn a_large_resume_message_does_not_hang_a_sender_that_does_not_read() {
        receive_over_a_small_pipe(1024, None).await;
    }

    /// A version 101 sender gets no `ResumeMsg` above the limit. It waits, then
    /// sends every chunk, and the transfer completes.
    #[tokio::test]
    async fn a_resuming_sender_with_no_resume_message_sends_every_chunk() {
        receive_over_a_small_pipe(1024, Some(std::time::Duration::from_millis(200))).await;
    }

    // 3.2: a fresh receive has an empty bitmap and holds NO bytes. The old
    // formula added one chunk length, so the bar reached 100% one chunk early.
    #[test]
    fn bytes_held_is_zero_for_an_empty_bitmap() {
        let m = binary_manifest(200, 64, 4);
        assert_eq!(bytes_held(&m, &[Some(ChunkBitmap::new(4))]), 0);
        // Two of four chunks: two chunk lengths.
        let mut bm = ChunkBitmap::new(4);
        bm.set(0);
        bm.set(1);
        assert_eq!(bytes_held(&m, &[Some(bm)]), 128);
        // A complete bitmap is capped at the item size, so a partial last chunk
        // does not overshoot.
        let mut full = ChunkBitmap::new(4);
        for i in 0..4 {
            full.set(i);
        }
        assert_eq!(bytes_held(&m, &[Some(full)]), 200);
        // A non-binary item has no bitmap and contributes nothing.
        assert_eq!(bytes_held(&Manifest::text("hi"), &[None]), 0);
    }

    // A3: only the LAST, partial chunk is held. Its real length is
    // size - (chunk_count - 1) * chunk_size, not a full chunk.
    #[test]
    fn bytes_held_counts_only_the_real_last_chunk() {
        // size 200, chunk 64: chunks 0..2 are 64 bytes, chunk 3 is 8 bytes.
        let m = binary_manifest(200, 64, 4);
        let mut last = ChunkBitmap::new(4);
        last.set(3);
        assert_eq!(bytes_held(&m, &[Some(last)]), 8);
        // The full chunks plus the partial last chunk sum to the item size.
        let mut all = ChunkBitmap::new(4);
        for i in 0..4 {
            all.set(i);
        }
        assert_eq!(bytes_held(&m, &[Some(all)]), 200);
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
                |_, _, _, _, _| {},
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
            group_roots: Vec::new(),
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

    // 3.1: a duplicate payload (payload_seen) writes no row, so the progress
    // callback must report credited == false. The engine closure maps that to
    // "no bytes_done write and no TransferProgress event".
    #[tokio::test]
    async fn a_duplicate_delivery_reports_no_credited_bytes() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let path = src.path().join("ok.bin");
        std::fs::write(&path, vec![7u8; 120_000]).unwrap();
        let item = Item::from_file(0, &path, 64 * 1024).unwrap();
        let manifest = Manifest::new(PayloadKind::Media, dev(), vec![item]);
        let db = crate::store::Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.add_inbox(&crate::store::inbox::InboxRow {
            id: manifest.payload_id,
            transfer_id: manifest.payload_id,
            peer_device_id: manifest.sender.device_id,
            kind: "media".into(),
            item_count: 1,
            summary: "1 file(s)".into(),
            received_at: 1,
            saved_paths: "[]".into(),
            group_roots: Vec::new(),
        })
        .unwrap();
        assert!(db.payload_seen(&manifest.payload_id).unwrap());

        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let m = manifest.clone();
        let sender = tokio::spawn(async move {
            crate::transfer::send_transfer(&mut theirs, &m, &[Some(path.clone())], &[], |_| {})
                .await
                .unwrap();
        });

        let mut credited: Vec<bool> = Vec::new();
        receive_transfer_from(
            &mut mine,
            None,
            dst.path(),
            |_, _, _, _, ok| credited.push(ok),
            Some(&db),
            |_| {},
        )
        .await
        .unwrap();
        sender.await.unwrap();

        assert!(!credited.is_empty(), "the sender sent at least one chunk");
        assert!(
            credited.iter().all(|c| !c),
            "a duplicate payload must credit no bytes, got {credited:?}"
        );
    }

    // T5: the resume seed counts held bytes twice when a re-sent chunk whose
    // bitmap bit is already set is credited again. Chunks 0 and 1 are held from
    // a prior attempt, so a full resend of them must not credit bytes. The
    // engine bar (seed + credited bytes) must reach 100% only on the last byte.
    #[tokio::test]
    async fn a_resumed_send_credits_only_the_bytes_that_land() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let path = src.path().join("a.bin");
        // Chunk size 64 KiB: chunks 0, 1, 2 are full, chunk 3 has 100 bytes.
        let chunk = CHUNK_SIZE_MIN as u64;
        let total = chunk * 3 + 100;
        std::fs::write(&path, vec![7u8; total as usize]).unwrap();
        let item = Item::from_file(0, &path, CHUNK_SIZE_MIN).unwrap();
        let manifest = Manifest::new(PayloadKind::Media, dev(), vec![item]);
        let db = crate::store::Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        // A prior partial receive holds chunks 0 and 1.
        let mut held = ChunkBitmap::new(4);
        held.set(0);
        held.set(1);
        db.save_bitmap(&manifest.payload_id, 0, &held).unwrap();
        // The bitmap is a hint: those bytes must really be on disk, or the
        // final hash quarantines the item.
        std::fs::write(dst.path().join("a.bin"), vec![7u8; (chunk * 2) as usize]).unwrap();
        // A prior partial receive also stores its destinations (F4).
        let mut list = Vec::new();
        ciborium::into_writer(&vec!["a.bin".to_string()], &mut list).unwrap();
        db.set_setting(&dest_key(&manifest.payload_id), &list)
            .unwrap();

        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let m = manifest.clone();
        let sender = tokio::spawn(async move {
            crate::transfer::send_transfer(&mut theirs, &m, &[Some(path.clone())], &[], |_| {})
                .await
                .unwrap();
        });

        // (initial bytes_held, new chunk bytes, credited) for each chunk.
        let mut calls: Vec<(u64, u64, bool)> = Vec::new();
        receive_transfer_from(
            &mut mine,
            None,
            dst.path(),
            |_, written, _, initial, credited| calls.push((initial, written, credited)),
            Some(&db),
            |_| {},
        )
        .await
        .unwrap();
        sender.await.unwrap();

        // Chunks 0 and 1 are held, so a full resend must not credit them.
        let credited: Vec<bool> = calls.iter().map(|c| c.2).collect();
        assert_eq!(
            credited,
            vec![false, false, true, true],
            "a re-sent chunk the bitmap already holds must not be credited"
        );
        assert_eq!(calls[0].0, chunk * 2, "the seed is the two held chunks");

        // Drive the REAL engine bar, ProgressGate, exactly as the engine closure
        // does: seed it on the first credited chunk with the held bytes, then add
        // each credited chunk. The interval is long, so the gate reports only on
        // the last byte.
        let now = std::time::Instant::now();
        let mut gate: Option<ProgressGate> = None;
        let mut reached_at: Option<usize> = None;
        for (i, (initial, written, ok)) in calls.iter().enumerate() {
            if !ok {
                continue;
            }
            let g = gate
                .get_or_insert_with(|| ProgressGate::new(*initial, total, PROGRESS_INTERVAL, now));
            if let Some((done, _)) = g.add(*written, now) {
                if done == total {
                    reached_at = Some(i);
                    break;
                }
            }
        }
        assert_eq!(
            reached_at,
            Some(calls.len() - 1),
            "the bar must reach 100% only on the last byte"
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

    fn group_item(index: u32, group: ciborium::value::Value, path: &str) -> Item {
        let mut item = peer_item(index, path);
        item.attrs.insert("group".into(), group);
        item
    }

    fn text(s: &str) -> ciborium::value::Value {
        ciborium::value::Value::Text(s.to_string())
    }

    fn batch(items: Vec<Item>) -> Manifest {
        Manifest::new(PayloadKind::Batch, dev(), items)
    }

    #[test]
    fn a_group_item_whose_path_does_not_start_with_its_group_is_refused() {
        let manifest = batch(vec![group_item(0, text("album"), "other/a.txt")]);
        assert!(matches!(
            validate_manifest(&manifest),
            Err(CoreError::Protocol(m)) if !m.contains("album") && !m.contains("other")
        ));
        // A prefix without the slash is not the group folder.
        let manifest = batch(vec![group_item(0, text("album"), "album2/a.txt")]);
        assert!(validate_manifest(&manifest).is_err());
        // A group item with no path is refused.
        let mut item = group_item(0, text("album"), "album/a.txt");
        item.attrs.remove("path");
        assert!(validate_manifest(&batch(vec![item])).is_err());
    }

    #[test]
    fn a_group_with_a_slash_a_backslash_no_text_or_a_non_text_value_is_refused() {
        let cases = [
            group_item(0, text("a/b"), "a/b/x.txt"),
            group_item(0, text("a\\b"), "a\\b/x.txt"),
            group_item(0, text(""), "/x.txt"),
            group_item(0, ciborium::value::Value::Integer(7.into()), "7/x.txt"),
            group_item(0, ciborium::value::Value::Bool(true), "true/x.txt"),
        ];
        for item in cases {
            assert!(validate_manifest(&batch(vec![item])).is_err());
        }
    }

    #[test]
    fn a_manifest_from_the_builder_is_accepted_for_an_unsafe_group_name_and_a_duplicate_folder_name(
    ) {
        let dir = tempfile::tempdir().unwrap();
        let mut picked = Vec::new();
        for parent in ["a", "b"] {
            let root = dir.path().join(parent).join("we:ird*name?");
            std::fs::create_dir_all(&root).unwrap();
            std::fs::write(root.join("one.jpg"), parent.as_bytes()).unwrap();
            picked.push(root);
        }
        let (manifest, _) =
            crate::manifest::from_picked_paths(dev(), &picked, CHUNK_SIZE_MIN).unwrap();
        assert!(manifest.items.iter().any(|i| i.attrs.contains_key("group")));
        validate_manifest(&manifest).unwrap();
    }

    #[test]
    fn an_item_with_no_group_is_accepted() {
        let manifest = batch(vec![peer_item(0, "plain/a.txt")]);
        validate_manifest(&manifest).unwrap();
    }

    #[test]
    fn a_matching_group_item_is_accepted() {
        let manifest = batch(vec![group_item(0, text("album"), "album/sub/a.txt")]);
        validate_manifest(&manifest).unwrap();
    }

    /// F3: a symlink ALREADY inside out_dir must not carry a write out of it.
    /// F4: the receiver creates each folder with `create_dir`, which does not
    /// follow a symlink. The symlink counts as an existing name, so the group
    /// takes the suffix. MemConn, so no socket is needed.
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

        res.unwrap();
        assert_eq!(
            std::fs::read(dst.path().join("sub-1/planted.bin")).unwrap(),
            vec![5u8; 40_000]
        );
        assert!(
            std::fs::symlink_metadata(dst.path().join("sub"))
                .unwrap()
                .file_type()
                .is_symlink(),
            "the symlink stays as it is"
        );
        assert_eq!(
            std::fs::read_dir(outside.path()).unwrap().count(),
            0,
            "no byte may land outside out_dir"
        );
    }

    /// F3, DEEP half. A symlink at the first component must not let the
    /// receiver create the components below it outside out_dir. The group
    /// takes the suffix, and every component is created inside out_dir.
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

        res.unwrap();
        assert_eq!(
            std::fs::read(dst.path().join("planted-1/deep/leaf.bin")).unwrap(),
            vec![7u8; 40_000]
        );
        assert!(
            !outside.path().join("deep").exists(),
            "nothing may be CREATED through the symlink"
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

    /// F4: the receiver does not refuse a manifest when two binary items
    /// resolve to one destination. Each shape below gives one destination for
    /// two items: the same path, two spellings of one path, a flat item and a
    /// path item, a non-text path and a flat item, and two flat items.
    #[test]
    fn validate_manifest_accepts_two_items_that_resolve_to_one_destination() {
        let flat = |index: u32, name: &str| Item {
            index,
            item_type: ItemType::Document,
            name: Some(name.into()),
            size: Some(100),
            chunk_size: Some(CHUNK_SIZE_MIN),
            chunk_count: Some(1),
            ..Default::default()
        };
        let mut odd = flat(0, "y.bin");
        odd.attrs
            .insert("path".into(), ciborium::value::Value::Integer(7.into()));
        let shapes = [
            vec![
                peer_item(0, "same/place.bin"),
                peer_item(1, "same/place.bin"),
            ],
            vec![peer_item(0, "a/place.bin"), peer_item(1, "./a//place.bin")],
            vec![flat(0, "x.bin"), peer_item(1, "x.bin")],
            vec![odd, flat(1, "y.bin")],
            vec![flat(0, "dup.bin"), flat(1, "dup.bin")],
        ];
        let out = Path::new("/tmp/out");
        for items in shapes {
            assert_eq!(
                item_destination(out, &items[0]).unwrap(),
                item_destination(out, &items[1]).unwrap(),
                "the two items must resolve to one destination"
            );
            validate_manifest(&batch(items)).unwrap();
        }
    }

    /// Every regular file below `dir`, as (path relative to `dir`, bytes).
    fn files_below(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for entry in std::fs::read_dir(&d).unwrap() {
                let path = entry.unwrap().path();
                let meta = std::fs::symlink_metadata(&path).unwrap();
                if meta.is_dir() {
                    stack.push(path);
                } else if meta.is_file() {
                    let bytes = std::fs::read(&path).unwrap();
                    out.push((path.strip_prefix(dir).unwrap().to_path_buf(), bytes));
                }
            }
        }
        out.sort();
        out
    }

    /// One entry for `deliver`: the item name, the attrs["path"] value or
    /// `None` for a flat item, and the bytes.
    type Entry<'a> = (&'a str, Option<&'a str>, &'a [u8]);

    /// Send one source file for each entry through the real sender into
    /// `out`. An entry with a path in a folder gets the first path component
    /// as its group.
    async fn deliver(out: &Path, entries: &[Entry<'_>], db: Option<&Db>) -> Result<Manifest> {
        let src = tempfile::tempdir().unwrap();
        let mut items = Vec::new();
        let mut paths = Vec::new();
        for (i, (name, rel, bytes)) in entries.iter().enumerate() {
            let p = src.path().join(format!("source_{i}"));
            std::fs::write(&p, bytes).unwrap();
            let mut item = Item::from_file(i as u32, &p, CHUNK_SIZE_MIN).unwrap();
            item.name = Some(name.to_string());
            if let Some(rel) = rel {
                item.attrs.insert("path".into(), text(rel));
                if let Some((group, _)) = rel.split_once('/') {
                    item.attrs.insert("group".into(), text(group));
                }
            }
            items.push(item);
            paths.push(Some(p));
        }
        let manifest = Manifest::new(PayloadKind::Batch, dev(), items);
        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let m = manifest.clone();
        let sender = tokio::spawn(async move {
            crate::transfer::send_transfer(&mut theirs, &m, &paths, &[], |_| {}).await
        });
        let res = receive_transfer(&mut mine, out, |_| {}, db, |_| {}).await;
        match res {
            Ok(_) => sender.await.unwrap().map(|_| manifest),
            Err(e) => {
                sender.abort();
                Err(e)
            }
        }
    }

    /// F4: a file that exists in out_dir is never opened for writing. The new
    /// file takes the next free suffix.
    #[tokio::test]
    async fn an_existing_file_in_out_dir_stays_byte_identical_and_the_new_file_is_name_dash_1() {
        let dst = tempfile::tempdir().unwrap();
        std::fs::write(dst.path().join("report.txt"), b"old").unwrap();

        deliver(dst.path(), &[("report.txt", None, b"first new")], None)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(dst.path().join("report.txt")).unwrap(),
            b"old"
        );
        assert_eq!(
            std::fs::read(dst.path().join("report-1.txt")).unwrap(),
            b"first new"
        );

        deliver(dst.path(), &[("report.txt", None, b"second new")], None)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(dst.path().join("report.txt")).unwrap(),
            b"old"
        );
        assert_eq!(
            std::fs::read(dst.path().join("report-1.txt")).unwrap(),
            b"first new"
        );
        assert_eq!(
            std::fs::read(dst.path().join("report-2.txt")).unwrap(),
            b"second new"
        );
    }

    /// F4: a folder group that exists takes the suffix as a whole. The
    /// receiver does not merge into the existing folder.
    #[tokio::test]
    async fn an_existing_folder_makes_the_whole_group_take_the_suffix() {
        let dst = tempfile::tempdir().unwrap();
        std::fs::create_dir(dst.path().join("album")).unwrap();
        std::fs::write(dst.path().join("album/keep.txt"), b"keep").unwrap();

        deliver(
            dst.path(),
            &[
                ("a.txt", Some("album/a.txt"), b"A"),
                ("b.txt", Some("album/sub/b.txt"), b"B"),
            ],
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            files_below(dst.path()),
            vec![
                (PathBuf::from("album/keep.txt"), b"keep".to_vec()),
                (PathBuf::from("album-1/a.txt"), b"A".to_vec()),
                (PathBuf::from("album-1/sub/b.txt"), b"B".to_vec()),
            ]
        );
    }

    /// F4: a hostile or old manifest names one destination for two items. The
    /// receiver keeps both files. The second takes the suffix.
    #[tokio::test]
    async fn a_hand_built_manifest_with_two_items_for_one_destination_arrives_as_two_files() {
        let dst = tempfile::tempdir().unwrap();
        deliver(
            dst.path(),
            &[
                ("place.bin", Some("same/place.bin"), b"one"),
                ("place.bin", Some("same/place.bin"), b"two"),
                ("place.bin", None, b"three"),
                ("place.bin", None, b"four"),
            ],
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            files_below(dst.path()),
            vec![
                (PathBuf::from("place-1.bin"), b"four".to_vec()),
                (PathBuf::from("place.bin"), b"three".to_vec()),
                (PathBuf::from("same/place-1.bin"), b"two".to_vec()),
                (PathBuf::from("same/place.bin"), b"one".to_vec()),
            ]
        );
    }

    /// F4: the suffix cuts the stem, so the name stays within 255 bytes.
    #[tokio::test]
    async fn a_name_of_255_bytes_gets_a_suffix_without_exceeding_255_bytes() {
        let dst = tempfile::tempdir().unwrap();
        let name = format!("{}.bin", "x".repeat(251));
        assert_eq!(name.len(), 255);
        std::fs::write(dst.path().join(&name), b"old").unwrap();

        deliver(dst.path(), &[(&name, None, b"new")], None)
            .await
            .unwrap();

        let files = files_below(dst.path());
        assert_eq!(files.len(), 2, "got {files:?}");
        assert!(files.contains(&(PathBuf::from(&name), b"old".to_vec())));
        let (new, _) = files.iter().find(|(_, b)| b == b"new").unwrap();
        let new = new.to_str().unwrap();
        assert!(new.len() <= 255, "{} bytes", new.len());
        assert!(new.ends_with("-1.bin"), "got {new}");
    }

    /// F4: the file system decides what exists. On a case-insensitive file
    /// system `a.txt` finds `A.txt`. On any file system both contents survive.
    #[tokio::test]
    #[allow(non_snake_case)]
    async fn pre_creating_A_txt_then_receiving_a_txt_keeps_both_contents_under_some_names() {
        let dst = tempfile::tempdir().unwrap();
        std::fs::write(dst.path().join("A.txt"), b"UPPER").unwrap();
        deliver(dst.path(), &[("a.txt", None, b"lower case bytes")], None)
            .await
            .unwrap();
        let contents: Vec<Vec<u8>> = files_below(dst.path()).into_iter().map(|f| f.1).collect();
        assert_eq!(contents.len(), 2, "got {contents:?}");
        assert!(contents.contains(&b"UPPER".to_vec()));
        assert!(contents.contains(&b"lower case bytes".to_vec()));
    }

    /// F4: APFS treats an NFC name and its NFD form as one file. Both contents
    /// survive on any file system.
    #[tokio::test]
    async fn an_nfc_and_an_nfd_name_that_the_file_system_treats_as_one_file_both_survive() {
        let dst = tempfile::tempdir().unwrap();
        let nfc = "caf\u{e9}.txt";
        let nfd = "cafe\u{301}.txt";
        std::fs::write(dst.path().join(nfc), b"composed").unwrap();
        deliver(dst.path(), &[(nfd, None, b"decomposed form")], None)
            .await
            .unwrap();
        let contents: Vec<Vec<u8>> = files_below(dst.path()).into_iter().map(|f| f.1).collect();
        assert_eq!(contents.len(), 2, "got {contents:?}");
        assert!(contents.contains(&b"composed".to_vec()));
        assert!(contents.contains(&b"decomposed form".to_vec()));
    }

    /// (pin) An empty file gets no chunk. The receiver creates it at manifest
    /// time, so the verify step finds it and the row is `done`.
    #[tokio::test]
    async fn an_empty_file_in_a_folder_is_created_and_verified() {
        let dst = tempfile::tempdir().unwrap();
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        let m = deliver(
            dst.path(),
            &[
                ("empty.txt", Some("album/empty.txt"), b""),
                ("x.bin", Some("album/x.bin"), b"data"),
            ],
            Some(&db),
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read(dst.path().join("album/empty.txt")).unwrap(),
            b""
        );
        let row = db.get_item(&m.payload_id, 0).unwrap().unwrap();
        assert_eq!(row.state, "done");
    }

    /// F2: the receiver opens the item file for each chunk. A file that turns
    /// read-only after the allocation fails the transfer. When the file is
    /// writable again, a second receive of the payload completes.
    #[cfg(unix)]
    #[tokio::test]
    async fn write_chunk_on_a_read_only_file_returns_an_error_and_the_transfer_can_resume() {
        use std::os::unix::fs::PermissionsExt;
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let path = src.path().join("x.bin");
        let bytes = vec![3u8; 40_000];
        std::fs::write(&path, &bytes).unwrap();
        let manifest = Manifest::new(
            PayloadKind::Media,
            dev(),
            vec![Item::from_file(0, &path, CHUNK_SIZE_MIN).unwrap()],
        );
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        let set_mode = |p: &Path, mode: u32| {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap()
        };

        // Pass 1: the peer sends the manifest. After the resume frame, the
        // file exists. The peer makes it read-only, then sends the chunk.
        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let m = manifest.clone();
        let target = dst.path().join("x.bin");
        let body = bytes.clone();
        let peer = tokio::spawn(async move {
            theirs
                .send(
                    CONTROL_STREAM,
                    RecordType::Manifest,
                    Bytes::from(m.to_cbor().unwrap()),
                )
                .await
                .unwrap();
            loop {
                let f = theirs.recv().await.unwrap().unwrap();
                if f.kind == RecordType::Nack {
                    break;
                }
            }
            set_mode(&target, 0o444);
            theirs
                .send(
                    100,
                    RecordType::Chunk,
                    Bytes::from(encode_chunk_body(0, 0, &body)),
                )
                .await
                .unwrap();
            theirs
        });
        let first = receive_transfer(&mut mine, dst.path(), |_| {}, Some(&db), |_| {}).await;
        let _theirs = peer.await.unwrap();
        assert!(first.is_err(), "a read-only file must fail, got {first:?}");
        set_mode(&dst.path().join("x.bin"), 0o644);

        // Pass 2: the real sender sends the same payload again.
        let (mut mine, mut theirs) = SecureConnection::<MemConn>::test_pair();
        let m = manifest.clone();
        let sender = tokio::spawn(async move {
            crate::transfer::send_transfer(&mut theirs, &m, &[Some(path.clone())], &[], |_| {})
                .await
        });
        receive_transfer(&mut mine, dst.path(), |_| {}, Some(&db), |_| {})
            .await
            .unwrap();
        sender.await.unwrap().unwrap();
        let row = db.get_item(&manifest.payload_id, 0).unwrap().unwrap();
        assert_eq!(row.state, "done");
        assert_eq!(std::fs::read(row.dest_path.unwrap()).unwrap(), bytes);
    }

    /// Allocate `n` flat items that all name one file, in a new directory.
    /// Return the time and the result.
    fn allocate_one_name(n: u32) -> (std::time::Duration, Result<()>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let mut item = peer_item(0, "x");
        item.attrs.clear();
        item.name = Some("dup.bin".into());
        let mut dirs = HashMap::new();
        let mut next = HashMap::new();
        let started = std::time::Instant::now();
        let res = (0..n).try_for_each(|i| {
            item.index = i;
            allocate_destination(dir.path(), &item, &mut dirs, &mut next, &mut Vec::new()).map(drop)
        });
        (started.elapsed(), res, dir)
    }

    /// F4: a hostile manifest of 65 536 items on one name must not cost
    /// quadratic time. The ratio test compares 1 000 items with 10 000 items,
    /// best of 3. Linear time gives a ratio of 10. Quadratic time gives 100.
    /// Past the cap of 10 000 suffixes the transfer fails. The error text
    /// names no file.
    #[test]
    fn a_manifest_of_65536_items_with_one_destination_allocates_in_linear_time() {
        let best = |n: u32| {
            (0..3)
                .map(|_| {
                    let (t, res, _dir) = allocate_one_name(n);
                    res.unwrap();
                    t
                })
                .min()
                .unwrap()
        };
        let small = best(1_000);
        let large = best(10_000);
        assert!(
            large < small * 40,
            "allocation is not linear: 1 000 items {small:?}, 10 000 items {large:?}"
        );

        let (_, res, dir) = allocate_one_name(65_536);
        let err = res.unwrap_err();
        assert!(matches!(err, CoreError::Transfer(_)), "got {err:?}");
        assert!(
            !err.to_string().contains("dup"),
            "the error names the file: {err}"
        );
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            SUFFIX_MAX as usize + 1,
            "the plain name and each suffix up to the cap"
        );
    }

    /// F2: a chunk write does not create the file. A deleted file is an error.
    #[tokio::test]
    async fn write_chunk_does_not_recreate_a_deleted_file() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("sub/gone.bin");
        std::fs::create_dir(root.path().join("sub")).unwrap();
        assert!(write_chunk(root.path(), &path, 0, b"data").await.is_err());
        assert!(!path.exists());
        // A missing directory is an error too. The write creates no directory.
        let deep = root.path().join("missing/gone.bin");
        assert!(write_chunk(root.path(), &deep, 0, b"data").await.is_err());
        assert!(!root.path().join("missing").exists());
    }

    /// F2: `O_NOFOLLOW` refuses a symlink at the last component. The check of
    /// the directory chain refuses a symlinked directory.
    #[cfg(unix)]
    #[tokio::test]
    async fn write_chunk_does_not_follow_a_symlink_at_the_last_component() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("target.bin");
        std::fs::write(&target, b"keep").unwrap();

        let link = root.path().join("link.bin");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(write_chunk(root.path(), &link, 0, b"evil").await.is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"keep");

        std::os::unix::fs::symlink(outside.path(), root.path().join("dir")).unwrap();
        let through = root.path().join("dir/target.bin");
        let err = write_chunk(root.path(), &through, 0, b"evil")
            .await
            .unwrap_err();
        assert!(
            !err.to_string().contains("target"),
            "the error names the file: {err}"
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"keep");
    }

    /// F2: the unit half of the read-only case. The write fails and the file
    /// keeps its bytes.
    #[cfg(unix)]
    #[tokio::test]
    async fn write_chunk_on_a_read_only_file_returns_an_error() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("ro.bin");
        std::fs::write(&path, b"old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();
        assert!(write_chunk(root.path(), &path, 0, b"new").await.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"old");
    }

    /// F4: an allocation error that is not `AlreadyExists` fails the receive.
    /// The receive removes the folders and files that it created, so a retry
    /// does not make `album-1`, `album-2`, and more. The existing folder stays.
    #[tokio::test]
    async fn a_failed_allocation_removes_what_it_created_so_a_retry_makes_no_new_suffix() {
        let dst = tempfile::tempdir().unwrap();
        std::fs::create_dir(dst.path().join("album")).unwrap();
        std::fs::write(dst.path().join("album/keep.txt"), b"keep").unwrap();
        let db = Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        // A name of 300 bytes: every file system here refuses it with an
        // error that is not `AlreadyExists`.
        let long = format!("album/{}.txt", "x".repeat(300));
        for _ in 0..2 {
            let res = deliver(
                dst.path(),
                &[
                    ("a.txt", Some("album/a.txt"), b"A"),
                    ("b.txt", Some("album/sub/b.txt"), b"B"),
                    ("c.txt", Some(&long), b"C"),
                ],
                Some(&db),
            )
            .await;
            assert!(res.is_err(), "the long name must fail, got {res:?}");
        }
        assert_eq!(
            files_below(dst.path()),
            vec![(PathBuf::from("album/keep.txt"), b"keep".to_vec())]
        );
        let top: Vec<_> = std::fs::read_dir(dst.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(top, vec![std::ffi::OsString::from("album")], "no album-1");
    }

    /// The bytes of every attrs["path"] in one manifest are capped at 16 MiB.
    /// The error names no path. 65 536 items with a path of 100 bytes pass.
    #[test]
    fn the_total_path_bytes_of_one_manifest_are_capped() {
        let fill = |i: u32, len: usize| {
            let head = format!("p/{i}-");
            format!("{head}{}", "x".repeat(len - head.len()))
        };
        let ok: Vec<Item> = (0..65_536u32)
            .map(|i| peer_item(i, &fill(i, 100)))
            .collect();
        validate_manifest(&batch(ok)).unwrap();

        let big: Vec<Item> = (0..4_200u32)
            .map(|i| peer_item(i, &fill(i, 4_000)))
            .collect();
        let err = validate_manifest(&batch(big)).unwrap_err();
        assert!(matches!(err, CoreError::Protocol(_)), "got {err:?}");
        assert!(
            !err.to_string().contains("xxx"),
            "the error names a path: {err}"
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
