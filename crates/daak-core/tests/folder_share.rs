//! B1: a folder share has to actually put bytes on the wire.
//!
//! The bug had two halves, and the second hid the first:
//!   1. The share entry points (daakd, daak-ffi) build a manifest with
//!      Item::from_file(i, path, ..) for every picked path, and a DIRECTORY
//!      makes that call fail outright (std::fs::metadata + File::open on a dir
//!      gives IsADirectory), so sharing a folder was refused.
//!   2. Even a folder Item that did get built has is_binary() == false and no
//!      chunk series of its own, so the sender streams nothing for it: the
//!      payload would go over the wire with zero folder bytes.
//!
//! The fix is one function, Item::from_folder, plus the manifest builders that
//! call it. It FLATTENS the tree: one binary item per regular file, each
//! carrying its share-root-relative path in attrs["path"].
//!
//! SPEC DISCREPANCY (second review; the earlier version of this header made the
//! OPPOSITE claim and was wrong). Spec 4.1 does NOT describe what the code
//! does. The spec models a folder as a NESTED item -- `? "children": [* item]`
//! -- with a single `chunk_count` "computed from the concatenated child
//! stream". The code instead emits N sibling binary items, each with its own
//! per-file `chunk_count`, and encodes the tree position out-of-band in
//! attrs["path"]. So this is a DELIBERATE DEPARTURE from spec 4.1, not
//! conformance to it. An earlier header here cited that very spec sentence as
//! support for the flattening; the sentence says the opposite, and the false
//! claim is what let the receiver-side gaps below go unnoticed.
//!
//! Why we depart: per-file `chunk_count` is what makes PER-ITEM resume possible.
//! A single concatenated child stream gives one chunk series for the whole
//! folder, so a disconnect at 90% forces a re-send of everything, and the
//! receiver cannot quarantine one bad file without discarding the folder. With
//! one item per file each file has its own bitmap, its own BLAKE2b, and its own
//! retry. The flattened shape also needed no wire-format change: attrs is a
//! passthrough map, so a peer that does not understand attrs["path"] sees N
//! ordinary binary items and simply writes them flat.
//!
//! Cost of the departure, stated plainly: (1) it is a wire-visible divergence
//! from the spec, so a spec-conformant receiver written against 4.1 would NOT
//! reconstruct our folder tree - it would write the files flat; (2) `children`
//! is therefore dead weight in the CDDL for now, and whoever reconciles the
//! spec should either amend 4.1 to describe the flattened form or add a real
//! nested-folder type later; (3) attrs["path"] is peer-controlled, so the
//! receiver must sanitise it - see below. Nothing under docs/superpowers/ was
//! edited; the discrepancy is reported to the user for a spec decision.
//!
//! IMPORTANT CORRECTION (review fix pass): an earlier version of this file's
//! header claimed the fix "needs NO receiver change". That was FALSE and the
//! claim did real damage here, because the roundtrip below was hand-fed a
//! pre-laid-out destination tree instead of driving the real receiver. The
//! receiver DOES have to change: attrs["path"] is peer-controlled, exactly
//! like `name`, so it is sanitised per component, capped in depth and length,
//! rejected when it names a reserved directory (`quarantine`, `staging`), and
//! rejected in validate_manifest when two items claim the same destination.
//! Every directory component it is about to create is additionally verified
//! with symlink_metadata BEFORE anything is created beneath it, so a symlink a
//! prior delivery planted inside out_dir cannot carry a write out of it.
//! The roundtrips below now go through the real send and receive paths so a
//! receiver regression cannot hide behind a hand-built fixture again.
//!
//! B2 owns the bytes_total/bytes_done question; this file deliberately does not
//! touch it.

use daak_core::manifest::{DeviceRef, Item, ItemType, Manifest, CHUNK_SIZE_DEFAULT};
use daak_core::net::tcp;
use daak_core::transfer::{receive_transfer, send_transfer};
use std::path::{Path, PathBuf};

fn make_tree(root: &Path) {
    std::fs::create_dir_all(root.join("sub/nested")).unwrap();
    std::fs::write(root.join("top.txt"), b"top level").unwrap();
    std::fs::write(root.join("sub/mid.bin"), vec![1u8; 70_000]).unwrap();
    std::fs::write(root.join("sub/nested/deep.txt"), b"deep").unwrap();
}

fn sender_ref() -> DeviceRef {
    DeviceRef {
        device_id: [1u8; 16],
        name: "s".into(),
    }
}

fn rel_path(item: &Item) -> String {
    match item.attrs.get("path") {
        Some(ciborium::value::Value::Text(s)) => s.clone(),
        other => panic!("expected a text attrs[path], got {other:?}"),
    }
}

/// Sorted, depth-first, regular files only. Sorting makes the item order
/// deterministic, which is what Manifest::batch's contiguity check needs.
/// symlink_metadata, not metadata: a symlink to a file or to a directory
/// OUTSIDE the share root must not be followed, and a symlinked directory
/// would recurse forever without this.
fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut entries: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(rd) => rd.filter_map(|e| e.ok().map(|e| e.path())).collect(),
        Err(_) => return out,
    };
    entries.sort();
    for p in entries {
        let meta = match std::fs::symlink_metadata(&p) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            out.extend(walk(&p));
        } else if meta.is_file() {
            out.push(p);
        }
    }
    out.sort();
    out
}

/// The manifest half: a picked directory becomes N binary items, one per
/// regular file, each with a share-root-relative attrs["path"].
#[test]
fn a_directory_becomes_one_item_per_file_with_relative_paths() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("album");
    make_tree(&root);

    let items = Item::from_folder(0, &root, CHUNK_SIZE_DEFAULT).unwrap();

    assert_eq!(
        items.len(),
        3,
        "one item per regular file; dirs are not items"
    );
    // Contiguous indices from 0, because Manifest::batch rejects anything else
    // and the sender indexes paths[item.index as usize].
    for (i, item) in items.iter().enumerate() {
        assert_eq!(item.index as usize, i, "indices must be contiguous from 0");
        assert!(
            item.is_binary(),
            "each child must carry its own chunk series"
        );
        assert!(item.size.is_some(), "item {i} has no size");
        assert!(item.hash.is_some(), "item {i} has no hash");
        assert!(item.chunk_count.is_some(), "item {i} has no chunk_count");
    }
    let paths: Vec<String> = items.iter().map(rel_path).collect();
    assert!(paths.contains(&"top.txt".to_string()), "got {paths:?}");
    assert!(paths.contains(&"sub/mid.bin".to_string()), "got {paths:?}");
    assert!(
        paths.contains(&"sub/nested/deep.txt".to_string()),
        "got {paths:?}"
    );
    // Names are unique within the share: staging is a flat namespace keyed by
    // name, so two "index.html" in different folders would otherwise stage
    // onto each other and ship one file's bytes under the other's hash.
    let mut names: Vec<&str> = items.iter().map(|i| i.name.as_deref().unwrap()).collect();
    let total = names.len();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), total, "item names must be unique: {names:?}");
}

/// A folder's bytes must not be silently zero: the child sizes sum to what is
/// actually on disk.
#[test]
fn a_folders_children_account_for_its_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("album");
    make_tree(&root);

    let items = Item::from_folder(0, &root, CHUNK_SIZE_DEFAULT).unwrap();
    let on_disk: u64 = walk(&root)
        .iter()
        .map(|p| std::fs::metadata(p).unwrap().len())
        .sum();
    let in_manifest: u64 = items.iter().filter_map(|i| i.size).sum();
    assert_eq!(in_manifest, on_disk);
    assert!(in_manifest > 0, "a folder share has real bytes to send");
}

/// The end-to-end half, and the one that would have caught the original bug:
/// a folder share lands as a TREE on the receiver, every byte intact.
///
/// This drives the REAL path end to end: `from_picked_paths` to build, the real
/// `Staging::stage` to lay down the copies (the same calls `outbox::enqueue`
/// makes), `staging.staged_path` to address them (the same lookup the outbox
/// drain does), and the real `send_transfer` / `receive_transfer`. The previous
/// version hand-copied into a flat tempdir with `std::fs::copy`, which proved
/// nothing about the enqueue->staging->drain path it claimed to cover.
#[tokio::test]
async fn a_folder_share_roundtrips_as_a_tree() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let root = src.path().join("album");
    make_tree(&root);

    let (manifest, sources) = from_picked_paths(
        sender_ref(),
        std::slice::from_ref(&root),
        CHUNK_SIZE_DEFAULT,
    )
    .unwrap();

    // The real staging root, addressed exactly as outbox::enqueue and the
    // outbox drain address it: root / <hex payload_id> / <manifest name>.
    let stage = tempfile::tempdir().unwrap();
    let staging = Staging::new(stage.path().to_path_buf());
    let mut paths: Vec<Option<PathBuf>> = Vec::new();
    for (item, src_path) in manifest.items.iter().zip(&sources) {
        let name = item.name.as_deref().unwrap();
        staging.stage(&manifest.payload_id, src_path, name).unwrap();
        paths.push(Some(staging.staged_path(&manifest.payload_id, name)));
    }

    let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let m = manifest.clone();
    let sender = tokio::spawn(async move {
        let (mut conn, _) = tcp::accept(&listener).await.unwrap();
        send_transfer(&mut conn, &m, &paths, &[], |_| {})
            .await
            .unwrap();
    });

    let mut conn = tcp::dial(addr).await.unwrap();
    receive_transfer(&mut conn, dst.path(), |_| {}, None, |_| {})
        .await
        .unwrap();
    sender.await.unwrap();

    // Every source file, byte for byte, at its place in the tree.
    for f in walk(&root) {
        let rel = f.strip_prefix(&root).unwrap();
        let landed = dst.path().join(rel);
        assert!(
            landed.exists(),
            "a folder child did not land: {}",
            rel.display()
        );
        assert_eq!(std::fs::read(&landed).unwrap(), std::fs::read(&f).unwrap());
    }
    assert_eq!(
        walk(dst.path()).len(),
        walk(&root).len(),
        "the receiver must get the same file count"
    );
}

/// A symlink pointing outside the shared root must not smuggle its target in,
/// and a symlinked directory must not make the walk recurse forever.
#[cfg(unix)]
#[test]
fn a_symlink_out_of_the_shared_root_is_not_followed() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("album");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("ok.txt"), b"mine").unwrap();
    let secret = dir.path().join("secret.txt");
    std::fs::write(&secret, b"not yours").unwrap();
    std::os::unix::fs::symlink(&secret, root.join("leak.txt")).unwrap();
    std::os::unix::fs::symlink(dir.path(), root.join("up")).unwrap();

    let items = Item::from_folder(0, &root, CHUNK_SIZE_DEFAULT).unwrap();
    let paths: Vec<String> = items.iter().map(rel_path).collect();
    assert_eq!(paths, vec!["ok.txt".to_string()], "got {paths:?}");
}

/// An empty directory is a legitimate share: zero items, not an error, and
/// definitely not a fabricated item.
#[test]
fn an_empty_directory_is_zero_items_not_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("empty");
    std::fs::create_dir_all(&root).unwrap();
    let items = Item::from_folder(0, &root, CHUNK_SIZE_DEFAULT).unwrap();
    assert!(items.is_empty());
}

/// A missing path is the caller's error to report, not an empty share.
#[test]
fn a_missing_path_is_an_error_not_an_empty_share() {
    let dir = tempfile::tempdir().unwrap();
    assert!(Item::from_folder(0, &dir.path().join("nope"), CHUNK_SIZE_DEFAULT).is_err());
}

/// A share mixing a folder and a plain file keeps both, with contiguous
/// indices, because that is what Manifest::batch and the sender demand.
#[test]
fn a_folder_mixed_with_a_plain_file_keeps_contiguous_indices() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("album");
    make_tree(&root);
    let loose = dir.path().join("loose.bin");
    std::fs::write(&loose, vec![3u8; 10]).unwrap();

    let mut items = Item::from_folder(0, &root, CHUNK_SIZE_DEFAULT).unwrap();
    let next = items.len() as u32;
    let mut file_item = Item::from_file(next, &loose, CHUNK_SIZE_DEFAULT).unwrap();
    file_item.attrs.insert(
        "path".into(),
        ciborium::value::Value::Text("loose.bin".into()),
    );
    items.push(file_item);

    let manifest = Manifest::batch(sender_ref(), items).unwrap();
    assert_eq!(manifest.items.len(), 4);
    for (i, item) in manifest.items.iter().enumerate() {
        assert_eq!(item.index as usize, i);
        assert!(item.is_binary(), "item {i} must carry its own bytes");
        assert_ne!(item.item_type, ItemType::Folder);
    }
}

// ---- the entry point: what daakd / daak-ffi / daak-cli all call ----

/// The picker hands over a MIX of files and folders. The builder has to turn
/// that into a manifest plus the item-index-keyed source paths the outbox
/// stages from, and it must not fail on a directory.
#[test]
fn the_share_builder_expands_folders_and_files_together() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("album");
    make_tree(&root);
    let loose = dir.path().join("loose.bin");
    std::fs::write(&loose, vec![3u8; 10]).unwrap();

    let picked = vec![root.clone(), loose.clone()];
    let (manifest, sources) = from_picked_paths(sender_ref(), &picked, CHUNK_SIZE_DEFAULT).unwrap();

    assert_eq!(
        manifest.items.len(),
        4,
        "3 folder children plus the loose file"
    );
    assert_eq!(
        sources.len(),
        4,
        "one source path per item, indexed by item index"
    );
    for (i, item) in manifest.items.iter().enumerate() {
        assert_eq!(item.index as usize, i);
        assert!(item.is_binary(), "item {i} carries no bytes");
        assert!(sources[i].exists(), "item {i} has no source to stage from");
    }
    // sources is indexed by ITEM index, which is what outbox::enqueue and
    // send_secure_with both assume.
    assert!(sources[0].starts_with(&root));
    assert_eq!(sources[3], loose);
    // The manifest a mixed share produces is a batch, not a single media item.
    assert_eq!(manifest.kind, daak_core::manifest::PayloadKind::Batch);
}

/// Two files with the SAME leaf name in different directories is the collision
/// that silently drops one of them if staging keeps a flat namespace. This
/// drives the REAL staging and asserts both bytes survive.
#[test]
fn same_named_files_in_different_folders_stay_separate_in_staging() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("album");
    std::fs::create_dir_all(root.join("a")).unwrap();
    std::fs::create_dir_all(root.join("b")).unwrap();
    std::fs::write(root.join("a/same.txt"), b"from a").unwrap();
    std::fs::write(root.join("b/same.txt"), b"from b").unwrap();

    let (manifest, sources) = from_picked_paths(
        sender_ref(),
        std::slice::from_ref(&root),
        CHUNK_SIZE_DEFAULT,
    )
    .unwrap();
    assert_eq!(manifest.items.len(), 2);

    let staging = Staging::new(dir.path().join("staging"));
    for (item, src) in manifest.items.iter().zip(&sources) {
        staging
            .stage(&manifest.payload_id, src, item.name.as_deref().unwrap())
            .unwrap();
    }
    let landed: Vec<String> = manifest
        .items
        .iter()
        .map(|i| {
            std::fs::read_to_string(
                staging.staged_path(&manifest.payload_id, i.name.as_deref().unwrap()),
            )
            .unwrap()
        })
        .collect();
    assert!(landed.contains(&"from a".to_string()), "got {landed:?}");
    assert!(landed.contains(&"from b".to_string()), "got {landed:?}");
}

use daak_core::manifest::from_picked_paths;
use daak_core::staging::Staging;

// ======================= FIX PASS (review findings) =======================

/// F1 (integration shape): every attrs["path"] a folder share emits is RELATIVE.
/// The error branch itself is pinned as a unit test in manifest.rs, because
/// `collect_files` builds every child path lexically from the root, so
/// from_folder cannot itself reach a failing strip_prefix. What this pins is the
/// property that failure was protecting.
#[test]
fn a_folder_share_never_puts_an_absolute_path_on_the_wire() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("album");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("ok.txt"), b"fine").unwrap();
    std::fs::create_dir_all(root.join("sub")).unwrap();
    std::fs::write(root.join("sub/deep.txt"), b"deep").unwrap();

    let (manifest, _sources) = from_picked_paths(
        sender_ref(),
        std::slice::from_ref(&root),
        CHUNK_SIZE_DEFAULT,
    )
    .unwrap();
    for item in &manifest.items {
        let rel = rel_path(item);
        assert!(
            !rel.starts_with('/') && !rel.contains("album"),
            "attrs[path] must be relative to the share root, got: {rel}"
        );
    }
}

/// F2: the used-name set is per-from_folder, so two picked folders each
/// holding notes.txt collide. Staging is flat per payload, so that hard-links
/// one item's staged file over another and the sender streams wrong bytes
/// against the wrong hash. Uniqueness must be per MANIFEST.
#[test]
fn two_folders_with_the_same_basename_produce_unique_manifest_names() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a");
    let b = dir.path().join("b");
    for root in [&a, &b] {
        std::fs::create_dir_all(root).unwrap();
        std::fs::write(root.join("notes.txt"), b"same basename").unwrap();
        std::fs::write(root.join("other.txt"), b"same basename").unwrap();
    }

    let (manifest, sources) =
        from_picked_paths(sender_ref(), &[a.clone(), b.clone()], CHUNK_SIZE_DEFAULT).unwrap();
    assert_eq!(manifest.items.len(), 4, "two files from each folder");

    let mut names: Vec<String> = manifest
        .items
        .iter()
        .map(|i| i.name.clone().unwrap())
        .collect();
    let total = names.len();
    names.sort();
    names.dedup();
    assert_eq!(
        names.len(),
        total,
        "names must be unique per manifest: {names:?}"
    );

    // And they really do stage to distinct files with distinct CONTENT, which is
    // the harm being fixed: one from folder a, one from folder b.
    let staging = Staging::new(dir.path().join("staging"));
    for (item, src) in manifest.items.iter().zip(&sources) {
        staging
            .stage(&manifest.payload_id, src, item.name.as_deref().unwrap())
            .unwrap();
    }
    let staged: Vec<(String, String)> = manifest
        .items
        .iter()
        .map(|i| {
            (
                i.name.clone().unwrap(),
                std::fs::read_to_string(
                    staging.staged_path(&manifest.payload_id, i.name.as_deref().unwrap()),
                )
                .unwrap(),
            )
        })
        .collect();
    assert_eq!(staged.len(), 4);
    // Both folders' notes.txt must still be present and DISTINCT on disk --
    // same bytes, so only the count can tell them apart, which is the point.
    let notes: Vec<&(String, String)> = staged
        .iter()
        .filter(|(n, _)| n.starts_with("notes"))
        .collect();
    assert_eq!(
        notes.len(),
        2,
        "both notes.txt must be staged, got {staged:?}"
    );
    for (name, _) in &notes {
        assert!(
            staging.staged_path(&manifest.payload_id, name).exists(),
            "staged copy missing for {name}"
        );
    }
}

/// F2b: a plain picked file whose name matches a folder child's must be in the
/// uniqueness set too, not just folder-derived names.
#[test]
fn a_loose_file_is_deduplicated_against_a_folder_child() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("album");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("shared.txt"), b"in the folder").unwrap();
    let loose = dir.path().join("shared.txt");
    std::fs::write(&loose, b"loose").unwrap();

    let (manifest, _sources) =
        from_picked_paths(sender_ref(), &[loose, root], CHUNK_SIZE_DEFAULT).unwrap();
    assert_eq!(manifest.items.len(), 2);
    let mut names: Vec<String> = manifest
        .items
        .iter()
        .map(|i| i.name.clone().unwrap())
        .collect();
    let total = names.len();
    names.sort();
    names.dedup();
    assert_eq!(
        names.len(),
        total,
        "a loose file must not reuse a child's name: {names:?}"
    );
}

/// F5: a non-Text attrs["path"] used to hit `_ => continue` in
/// from_picked_paths, dropping the child and shifting every later source index
/// by one -- so `sources[i]` stopped naming item i and the sender streamed one
/// file's bytes against the other's hash. It is now an error. The branch itself
/// is private and pinned by the `item_rel` unit test in manifest.rs; what this
/// pins is the property that matters at the boundary: for any tree the builder
/// accepts, `sources[i]` IS item i's file.
#[test]
fn sources_stay_aligned_with_item_indices() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("album");
    make_tree(&root);
    let loose = dir.path().join("loose.bin");
    std::fs::write(&loose, vec![3u8; 10]).unwrap();

    let (manifest, sources) =
        from_picked_paths(sender_ref(), &[root.clone(), loose], CHUNK_SIZE_DEFAULT).unwrap();
    assert_eq!(manifest.items.len(), sources.len());
    for (i, item) in manifest.items.iter().enumerate() {
        // The source named for item i must be the file item i describes: same
        // size, same hash. A dropped child breaks this from the drop onward.
        let bytes = std::fs::read(&sources[i]).unwrap();
        assert_eq!(item.size, Some(bytes.len() as u64), "item {i} size");
        assert_eq!(
            item.hash,
            Some(daak_core::hash::blake2b256(&bytes)),
            "item {i} hash does not match its own source"
        );
        if sources[i].starts_with(&root) {
            assert_eq!(sources[i], root.join(rel_path(item)), "item {i} path");
        }
    }
}

/// The reported symptom, end to end through the OUTBOX: queue a folder share
/// against an unreachable peer (which is what a share to someone not on the
/// LAN actually is) and the payload must be accepted, with the folder's bytes
/// in the row rather than an empty payload that still counts.
#[tokio::test]
async fn a_folder_share_queues_through_the_outbox_with_its_bytes() {
    use daak_core::outbox::enqueue;
    use daak_core::store::Db;

    let db = Db::open_in_memory().unwrap();
    db.migrate().unwrap();
    let stage = tempfile::tempdir().unwrap();
    let staging = Staging::new(stage.path().to_path_buf());
    let src = tempfile::tempdir().unwrap();
    let root = src.path().join("album");
    make_tree(&root);

    let (manifest, sources) = from_picked_paths(
        sender_ref(),
        std::slice::from_ref(&root),
        CHUNK_SIZE_DEFAULT,
    )
    .unwrap();
    let on_disk: u64 = walk(&src.path().join("album"))
        .iter()
        .map(|p| std::fs::metadata(p).unwrap().len())
        .sum();
    let id = enqueue(&db, &staging, &[9u8; 16], &manifest, &sources).unwrap();
    assert_eq!(id, manifest.payload_id);

    let row = db.get_outbox(&id).unwrap().unwrap();
    assert!(
        row.total_bytes > 0,
        "a folder share queued with zero bytes is the bug this test pins"
    );
    assert_eq!(row.total_bytes, on_disk);
    let transfer = db
        .list_transfers(None, None)
        .unwrap()
        .into_iter()
        .find(|t| t.transfer_id == id)
        .expect("a queued folder share must be a visible transfers row");
    assert_eq!(transfer.bytes_total, on_disk);
    assert_eq!(transfer.bytes_done, 0);
    assert_eq!(transfer.item_count, 3);
}

// ======================= the real send/receive path =======================

/// Stage a built manifest exactly as outbox::enqueue does, and return the
/// paths vector the outbox drain hands the sender.
fn stage_manifest(
    staging: &Staging,
    manifest: &Manifest,
    sources: &[PathBuf],
) -> Vec<Option<PathBuf>> {
    manifest
        .items
        .iter()
        .map(|item| {
            let name = item.name.as_deref().unwrap();
            staging
                .stage(&manifest.payload_id, &sources[item.index as usize], name)
                .unwrap();
            Some(staging.staged_path(&manifest.payload_id, name))
        })
        .collect()
}

/// A connection that dies MID-FOLDER and is then resumed. This is the normal
/// case for a folder share (a multi-GiB folder does not arrive in one go), and
/// it is the one the flat hand-built fixtures could never exercise: the nested
/// item's destination has to survive the drop, and the resumed pass has to land
/// the REST of its chunks in that same nested file.
#[tokio::test]
async fn a_folder_share_resumes_mid_folder_through_the_real_receiver() {
    use daak_core::manifest::CHUNK_SIZE_MIN;
    use daak_core::store::Db;

    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let root = src.path().join("album");
    let nested: Vec<u8> = (0..(CHUNK_SIZE_MIN as usize * 3 + 17))
        .map(|i| (i % 251) as u8)
        .collect();
    std::fs::create_dir_all(root.join("sub/nested")).unwrap();
    std::fs::write(root.join("top.txt"), b"top level").unwrap();
    std::fs::write(root.join("sub/nested/deep.bin"), &nested).unwrap();

    let (manifest, sources) = from_picked_paths(sender_ref(), &[root], CHUNK_SIZE_MIN).unwrap();
    let stage = tempfile::tempdir().unwrap();
    let staging = Staging::new(stage.path().to_path_buf());
    let paths = stage_manifest(&staging, &manifest, &sources);

    let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let m1 = manifest.clone();
    // Sorted order puts sub/nested/deep.bin FIRST, so look the item up by its
    // attrs path rather than assuming an index.
    let nested_index = manifest
        .items
        .iter()
        .position(|i| rel_path(i) == "sub/nested/deep.bin")
        .expect("the nested item must be in the manifest");
    let nested_bytes = std::fs::read(paths[nested_index].as_ref().unwrap()).unwrap();
    let dropper = tokio::spawn(async move {
        let (mut conn, _) = tcp::accept(&listener).await.unwrap();
        // Hand-rolled on purpose: send_transfer ALWAYS waits for an Ack, so it
        // cannot model a peer that dies mid-transfer. Manifest, then chunk 0 of
        // the NESTED item (item 1, the first 64 KiB), then the socket dies.
        use daak_core::framing::RecordType;
        use daak_core::net::CONTROL_STREAM;
        conn.send(
            CONTROL_STREAM,
            RecordType::Manifest,
            bytes::Bytes::from(m1.to_cbor().unwrap()),
        )
        .await
        .unwrap();
        let head = CHUNK_SIZE_MIN as usize;
        let body =
            daak_core::transfer::encode_chunk_body(nested_index as u32, 0, &nested_bytes[..head]);
        conn.send(100, RecordType::Chunk, bytes::Bytes::from(body))
            .await
            .unwrap();
        // conn drops here: the mid-folder disconnect.
    });
    let db = Db::open_in_memory().unwrap();
    db.migrate().unwrap();
    let mut conn = tcp::dial(addr).await.unwrap();
    let first = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        receive_transfer(&mut conn, dst.path(), |_| {}, Some(&db), |_| {}),
    )
    .await
    .expect("pass 1 receive hung");
    dropper.await.unwrap();
    assert!(
        matches!(first, Err(daak_core::CoreError::TransferInterrupted)),
        "a mid-folder drop must be an interrupt, got {first:?}"
    );

    let deep = dst.path().join("sub/nested/deep.bin");
    assert!(
        deep.exists(),
        "the nested destination must exist after the first pass"
    );
    assert!(
        std::fs::metadata(&deep).unwrap().len() < nested.len() as u64,
        "the first pass must not have finished the nested item"
    );

    let (listener2, addr2) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let m2 = manifest.clone();
    let p2 = paths.clone();
    // The resuming peer knows what landed only from the receiver's persisted
    // bitmaps, so build the pass-2 plan from them. If the receiver ignores its
    // own resume state this plan still covers every chunk and the test cannot
    // tell the difference -- so the progress assertion below is the real pin:
    // a correct resume re-sends only the gaps.
    let mut ranges: Vec<Vec<(u64, u64)>> = vec![Vec::new(); manifest.items.len()];
    let mut expected_pass2_bytes = 0u64;
    for item in manifest.binary_items() {
        let (size, chunk_size) = (item.size.unwrap(), item.chunk_size.unwrap() as u64);
        let stored = db
            .load_bitmap(&manifest.payload_id, item.index, item.chunk_count.unwrap())
            .unwrap();
        let gaps: Vec<(u64, u64)> = stored
            .missing_ranges()
            .into_iter()
            .map(|r| (r.start, r.end))
            .collect();
        for (s, e) in &gaps {
            // Byte extents, not chunk counts: the LAST chunk of an item is
            // short, so charging it a full chunk_size would over-count.
            let lo = s * chunk_size;
            let hi = (e * chunk_size).min(size);
            expected_pass2_bytes += hi.saturating_sub(lo);
        }
        ranges[item.index as usize] = gaps;
    }
    assert_ne!(
        expected_pass2_bytes, 0,
        "pass 1 must leave a real gap for pass 2 to resume"
    );
    let sender = tokio::spawn(async move {
        let (mut conn, _) = tcp::accept(&listener2).await.unwrap();
        send_transfer(&mut conn, &m2, &p2, &ranges, |_| {})
            .await
            .unwrap();
    });
    let mut conn2 = tcp::dial(addr2).await.unwrap();
    let mut pass2_bytes = 0u64;
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        receive_transfer(&mut conn2, dst.path(), |n| pass2_bytes += n, Some(&db), |_| {}),
    )
    .await
    .expect("pass 2 receive hung: the receiver is waiting for a chunk the resuming sender correctly never re-sends")
    .unwrap();
    sender.await.unwrap();

    // THE pin. Pass 1 already delivered chunk 0 of the nested item; a receiver
    // that honours its persisted bitmap re-requests only the gap, so exactly
    // the missing bytes are streamed in pass 2. A receiver that ignores its own
    // resume state would re-request everything and this fails.
    assert_eq!(
        pass2_bytes, expected_pass2_bytes,
        "pass 2 must stream only the chunks pass 1 never delivered"
    );

    assert_eq!(std::fs::read(&deep).unwrap(), nested);
    assert_eq!(
        std::fs::read(dst.path().join("top.txt")).unwrap(),
        b"top level"
    );
}

/// A share mixing a TEXT item and a FOLDER, end to end through the real
/// receiver. The previous coverage only checked the manifest's indices and
/// never performed a receive, so a text item and folder children arriving in
/// the same payload was untested.
#[tokio::test]
async fn a_mixed_text_and_folder_share_is_received_end_to_end() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let root = src.path().join("album");
    make_tree(&root);
    let loose = src.path().join("loose.bin");
    std::fs::write(&loose, vec![3u8; 10]).unwrap();

    // Build the mixed share the way daak-cli does: a folder plus a loose file,
    // then a text item appended to the same batch.
    let (mut manifest, sources) =
        from_picked_paths(sender_ref(), &[root.clone(), loose], CHUNK_SIZE_DEFAULT).unwrap();
    manifest
        .items
        .push(Item::text(manifest.items.len() as u32, "here is my note"));
    manifest.kind = daak_core::manifest::PayloadKind::Batch;

    let stage = tempfile::tempdir().unwrap();
    let staging = Staging::new(stage.path().to_path_buf());
    let paths: Vec<Option<PathBuf>> = manifest
        .items
        .iter()
        .map(|item| {
            if !item.is_binary() {
                return None;
            }
            let name = item.name.as_deref().unwrap();
            staging
                .stage(&manifest.payload_id, &sources[item.index as usize], name)
                .unwrap();
            Some(staging.staged_path(&manifest.payload_id, name))
        })
        .collect();

    let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let m = manifest.clone();
    let sender = tokio::spawn(async move {
        let (mut conn, _) = tcp::accept(&listener).await.unwrap();
        send_transfer(&mut conn, &m, &paths, &[], |_| {})
            .await
            .unwrap();
    });
    let mut conn = tcp::dial(addr).await.unwrap();
    let received = receive_transfer(&mut conn, dst.path(), |_| {}, None, |_| {})
        .await
        .unwrap();
    sender.await.unwrap();

    // The text item survived inline on the manifest the receiver returns.
    let text = received
        .items
        .iter()
        .find(|i| !i.is_binary())
        .expect("the text item must survive the round trip");
    assert_eq!(text.text.as_deref(), Some("here is my note"));
    // And the folder landed as a tree, with the loose file beside it.
    for f in walk(&root) {
        let rel = f.strip_prefix(&root).unwrap();
        assert_eq!(
            std::fs::read(dst.path().join(rel)).unwrap(),
            std::fs::read(&f).unwrap(),
            "folder child {}",
            rel.display()
        );
    }
    assert!(dst.path().join("loose.bin").exists());
}

/// The reviewer's exact scenario, end to end: pick the loose file `x.bin` AND
/// a folder `album/` that also contains a TOP-LEVEL `x.bin` -- what the iOS
/// share sheet produces when a user picks a folder plus a file from inside it.
///
/// The two items got distinct MANIFEST names (`x.bin` and `x.bin~1`), so
/// staging held two files and the sender streamed both correctly -- but names
/// are not destinations. The loose item carries no attrs["path"] and resolved
/// to out_dir/x.bin, while the folder child carries attrs["path"] == "x.bin"
/// and ALSO resolves to out_dir/x.bin. The receiver opened ONE file with
/// truncate(false) for both
/// and interleaved their chunks: BLAKE2b on item 0 failed, the whole transfer
/// errored, and the file was quarantined with no explanation. A hard failure on
/// an entirely ordinary mixed share.
///
/// The fix is in the BUILDER, because that is where the collision is created:
/// from_picked_paths now deduplicates the folder child's attrs["path"] against
/// every loose file's destination, so the child goes out as `x.bin~1` and the
/// two land in different files. The receiver keeps its duplicate-destination
/// rejection as a backstop against a hand-built or hostile manifest; it must
/// never fire on a manifest the builder produced, and the socket-free unit test
/// in manifest.rs (a_loose_file_naming_a_folder_child_gets_a_distinct_destination)
/// is what pins that. This file just proves the bytes land.
#[tokio::test]
async fn a_loose_file_naming_a_folder_child_does_not_collide_on_the_receiver() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let root = src.path().join("album");
    std::fs::create_dir_all(&root).unwrap();
    let in_folder: Vec<u8> = (0..40_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(root.join("x.bin"), &in_folder).unwrap();
    let loose: Vec<u8> = (0..40_000u32).map(|i| (i % 253) as u8).collect();
    let loose_path = src.path().join("x.bin");
    std::fs::write(&loose_path, &loose).unwrap();

    let (manifest, sources) =
        from_picked_paths(sender_ref(), &[loose_path, root], CHUNK_SIZE_DEFAULT).unwrap();
    assert_eq!(manifest.items.len(), 2);
    // The premise: the two items claim one destination through the two
    // DIFFERENT resolution paths. Without this the test proves nothing.
    assert!(!manifest.items[0].attrs.contains_key("path"));
    // The FOLDER child yields, because from_picked_paths seeds the destination
    // set with every loose file up front, so the outcome does not depend on
    // pick order: the loose file always keeps the bare `x.bin` and the child is
    // suffixed on its way out.
    assert_eq!(rel_path(&manifest.items[1]), "x.bin~1");
    assert_ne!(manifest.items[0].name, manifest.items[1].name);

    let stage = tempfile::tempdir().unwrap();
    let staging = Staging::new(stage.path().to_path_buf());
    let paths = stage_manifest(&staging, &manifest, &sources);

    let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let m = manifest.clone();
    let sender = tokio::spawn(async move {
        let (mut conn, _) = tcp::accept(&listener).await.unwrap();
        send_transfer(&mut conn, &m, &paths, &[], |_| {})
            .await
            .unwrap();
    });
    let mut conn = tcp::dial(addr).await.unwrap();
    let received = receive_transfer(&mut conn, dst.path(), |_| {}, None, |_| {}).await;
    sender.await.unwrap();

    let received = received.expect("the share must not fail with a hash mismatch");
    assert_eq!(received.items.len(), 2);
    // Nothing quarantined, and both bytes intact at the two DISTINCT places the
    // rules put them: the loose file flat, the folder child under its path.
    assert!(
        !dst.path().join("quarantine").exists(),
        "a file was quarantined"
    );
    assert_eq!(std::fs::read(dst.path().join("x.bin")).unwrap(), loose);
    // FLAT under the share root, exactly as `a_folder_share_roundtrips_as_a_tree`
    // already pins: attrs["path"] is relative to the picked ROOT, so picking
    // `album/` does not recreate an `album/` level on the receiver -- the share
    // root IS out_dir. The picked folder's own basename is not preserved as a
    // directory. See the folder-tree note in the B1 ledger entry.
    assert_eq!(
        std::fs::read(dst.path().join("x.bin~1")).unwrap(),
        in_folder,
        "the folder child must land at its (deduplicated) attrs path"
    );
}

/// The same share picked the other way round: the folder first, the loose file
/// second. The builder seeds its destination set with the loose files, so the
/// FOLDER yields the name in both orders and the receiver ends up with the same
/// two files either way -- a picker that reorders the user's selection must not
/// decide whether their share works.
#[tokio::test]
async fn the_folder_first_order_also_delivers_both_files() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let root = src.path().join("album");
    std::fs::create_dir_all(&root).unwrap();
    let in_folder: Vec<u8> = (0..40_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(root.join("x.bin"), &in_folder).unwrap();
    let loose: Vec<u8> = (0..40_000u32).map(|i| (i % 253) as u8).collect();
    let loose_path = src.path().join("x.bin");
    std::fs::write(&loose_path, &loose).unwrap();

    let (manifest, sources) =
        from_picked_paths(sender_ref(), &[root, loose_path], CHUNK_SIZE_DEFAULT).unwrap();
    assert_eq!(manifest.items.len(), 2);
    assert_eq!(rel_path(&manifest.items[0]), "x.bin~1");
    assert!(!manifest.items[1].attrs.contains_key("path"));

    let stage = tempfile::tempdir().unwrap();
    let staging = Staging::new(stage.path().to_path_buf());
    let paths = stage_manifest(&staging, &manifest, &sources);

    let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let m = manifest.clone();
    let sender = tokio::spawn(async move {
        let (mut conn, _) = tcp::accept(&listener).await.unwrap();
        send_transfer(&mut conn, &m, &paths, &[], |_| {})
            .await
            .unwrap();
    });
    let mut conn = tcp::dial(addr).await.unwrap();
    let received = receive_transfer(&mut conn, dst.path(), |_| {}, None, |_| {}).await;
    sender.await.unwrap();

    let received = received.expect("the share must not fail with a hash mismatch");
    assert_eq!(received.items.len(), 2);
    assert!(
        !dst.path().join("quarantine").exists(),
        "a file was quarantined"
    );
    assert_eq!(std::fs::read(dst.path().join("x.bin")).unwrap(), loose);
    assert_eq!(
        std::fs::read(dst.path().join("x.bin~1")).unwrap(),
        in_folder,
        "the folder child must land under its (deduplicated) attrs path"
    );
}
