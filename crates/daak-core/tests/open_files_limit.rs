//! F2 sender: the sender opens each source file once for each chunk.
//!
//! The sender holds no file handle between chunks. So a folder of hundreds of
//! files sends at the soft limit of 256 open files on iOS and macOS. Each open
//! checks that the file did not change since the manifest was built.
//!
//! These tests use `Sink`, a receiver with no socket. The 600 file test runs
//! its body in a child process with `ulimit -n 256`.

mod support;

use std::path::{Path, PathBuf};

use daak_core::manifest::{
    from_picked_paths, Item, Manifest, PayloadKind, CHUNK_SIZE_DEFAULT, CHUNK_SIZE_MIN,
};
use daak_core::CoreError;
use support::{
    bytes_of_len, in_child, run_in_child_with_nofile, send_without_resume_frame, sender_ref, Sink,
    CHUNK,
};

/// A file of 3 full chunks of `CHUNK_SIZE_MIN`, with its one item manifest.
fn three_chunk_file(dir: &Path) -> (Manifest, Vec<Option<PathBuf>>, PathBuf, Vec<u8>) {
    let path = dir.join("a.bin");
    let original = bytes_of_len(1, CHUNK * 3);
    std::fs::write(&path, &original).unwrap();
    let item = Item::from_file(0, &path, CHUNK_SIZE_MIN).unwrap();
    assert_eq!(item.chunk_count, Some(3));
    let manifest = Manifest::new(PayloadKind::Media, sender_ref(), vec![item]);
    (manifest, vec![Some(path.clone())], path, original)
}

/// Every chunk on the wire must hold the original bytes at its offset.
fn assert_only_original_bytes(sink: &Sink, original: &[u8]) {
    for (item, chunk, data) in &sink.chunks {
        assert_eq!(*item, 0);
        let start = *chunk as usize * CHUNK;
        assert!(
            original.get(start..start + data.len()) == Some(&data[..]),
            "chunk {chunk} holds bytes that are not in the original file"
        );
    }
}

/// The error must be the transfer error. Its text must hold no file name.
fn assert_transfer_error_with_no_name(r: daak_core::Result<()>, dir: &Path) {
    let e = r.expect_err("the send must fail");
    let text = e.to_string();
    assert!(
        matches!(e, CoreError::Transfer(_)),
        "a changed file is a transfer error, got {e:?}"
    );
    assert!(!text.contains("a.bin"), "the error names the file: {text}");
    assert!(
        !text.contains(&*dir.to_string_lossy()),
        "the error names the folder: {text}"
    );
}

#[tokio::test]
async fn a_sender_only_round_trip_of_600_files_works_at_256_open_files() {
    if !in_child() {
        run_in_child_with_nofile(
            256,
            "a_sender_only_round_trip_of_600_files_works_at_256_open_files",
        );
        return;
    }
    let src = tempfile::tempdir().unwrap();
    let root = src.path().join("many");
    std::fs::create_dir_all(&root).unwrap();
    for i in 0..600u32 {
        let name = format!("f{i:03}.bin");
        std::fs::write(root.join(name), bytes_of_len(i as u8, 100 + i as usize)).unwrap();
    }
    for i in 0..3 {
        std::fs::write(root.join(format!("empty{i}.bin")), b"").unwrap();
    }
    let (manifest, sources) = from_picked_paths(sender_ref(), &[root], CHUNK_SIZE_MIN).unwrap();
    assert_eq!(manifest.items.len(), 603);
    let paths: Vec<Option<PathBuf>> = sources.iter().cloned().map(Some).collect();

    let mut sink = Sink::new();
    send_without_resume_frame(&mut sink, &manifest, &paths, |_| {})
        .await
        .unwrap();

    for (item, source) in manifest.items.iter().zip(&sources) {
        assert_eq!(
            sink.item_bytes(item.index),
            std::fs::read(source).unwrap(),
            "item {} has the wrong bytes",
            item.index
        );
    }
}

#[tokio::test]
async fn a_source_file_replaced_between_chunks_fails_the_send_and_no_foreign_byte_reaches_the_wire()
{
    let dir = tempfile::tempdir().unwrap();
    let (manifest, paths, path, original) = three_chunk_file(dir.path());
    let swap = dir.path().join("swap.tmp");
    let target = path.clone();
    // An editor saves atomically: it writes a new file, then renames it over
    // the old path. The new file has a new inode and the same size.
    let mut sink = Sink::with_hook(move |_, chunk| {
        if chunk == 0 {
            std::fs::write(&swap, bytes_of_len(99, CHUNK * 3)).unwrap();
            std::fs::rename(&swap, &target).unwrap();
        }
    });
    let r = send_without_resume_frame(&mut sink, &manifest, &paths, |_| {}).await;
    assert_only_original_bytes(&sink, &original);
    assert_transfer_error_with_no_name(r, dir.path());
    assert_eq!(sink.chunks.len(), 1, "no chunk leaves after the change");
}

#[tokio::test]
async fn a_source_file_truncated_between_chunks_fails_the_send_and_sends_no_foreign_byte() {
    let dir = tempfile::tempdir().unwrap();
    let (manifest, paths, path, original) = three_chunk_file(dir.path());
    let target = path.clone();
    // The same inode gets new, shorter content.
    let mut sink = Sink::with_hook(move |_, chunk| {
        if chunk == 0 {
            std::fs::write(&target, bytes_of_len(99, CHUNK + 10)).unwrap();
        }
    });
    let r = send_without_resume_frame(&mut sink, &manifest, &paths, |_| {}).await;
    assert_only_original_bytes(&sink, &original);
    assert_transfer_error_with_no_name(r, dir.path());
    assert_eq!(sink.chunks.len(), 1, "no chunk leaves after the change");
}

/// Pin: this test passes before and after F2. A symlink that replaces the
/// source path after chunk 1 must not put the bytes of its target on the wire.
#[cfg(unix)]
#[tokio::test]
async fn a_symlink_swapped_in_for_a_source_file_is_not_followed() {
    let dir = tempfile::tempdir().unwrap();
    let (manifest, paths, path, original) = three_chunk_file(dir.path());
    let other = dir.path().join("other.bin");
    std::fs::write(&other, bytes_of_len(99, CHUNK * 3)).unwrap();
    let target = path.clone();
    let mut sink = Sink::with_hook(move |_, chunk| {
        if chunk == 0 {
            std::fs::remove_file(&target).unwrap();
            std::os::unix::fs::symlink(&other, &target).unwrap();
        }
    });
    let _ = send_without_resume_frame(&mut sink, &manifest, &paths, |_| {}).await;
    assert_only_original_bytes(&sink, &original);
}

/// Pin: this test passes before and after F2. A file of exactly one chunk and
/// a file of one chunk and 1 byte send every byte at the default chunk size.
#[tokio::test]
async fn files_of_exactly_1_mib_and_1_mib_plus_1_byte_send_correctly() {
    let src = tempfile::tempdir().unwrap();
    let root = src.path().join("edge");
    std::fs::create_dir_all(&root).unwrap();
    let mib = CHUNK_SIZE_DEFAULT as usize;
    std::fs::write(root.join("a.bin"), bytes_of_len(1, mib)).unwrap();
    std::fs::write(root.join("b.bin"), bytes_of_len(2, mib + 1)).unwrap();
    let (manifest, sources) = from_picked_paths(sender_ref(), &[root], CHUNK_SIZE_DEFAULT).unwrap();
    let paths: Vec<Option<PathBuf>> = sources.iter().cloned().map(Some).collect();

    let mut sink = Sink::new();
    send_without_resume_frame(&mut sink, &manifest, &paths, |_| {})
        .await
        .unwrap();

    let mut counts = Vec::new();
    for (item, source) in manifest.items.iter().zip(&sources) {
        let want = std::fs::read(source).unwrap();
        let n = sink.chunks.iter().filter(|c| c.0 == item.index).count();
        counts.push((want.len(), n));
        assert_eq!(sink.item_bytes(item.index), want);
    }
    counts.sort();
    assert_eq!(counts, vec![(mib, 1), (mib + 1, 2)]);
}

/// A picked path that is a symlink to a file still sends. The sender resolves
/// the path at schedule time and opens the resolved file for each chunk.
#[cfg(unix)]
#[tokio::test]
async fn a_top_level_symlink_to_a_file_still_sends() {
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real.bin");
    let original = bytes_of_len(1, CHUNK * 3);
    std::fs::write(&real, &original).unwrap();
    let link = dir.path().join("link.bin");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let item = Item::from_file(0, &link, CHUNK_SIZE_MIN).unwrap();
    let manifest = Manifest::new(PayloadKind::Media, sender_ref(), vec![item]);

    let mut sink = Sink::new();
    send_without_resume_frame(&mut sink, &manifest, &[Some(link)], |_| {})
        .await
        .unwrap();
    assert_eq!(sink.item_bytes(0), original);
}
