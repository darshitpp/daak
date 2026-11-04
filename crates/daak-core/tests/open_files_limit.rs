//! F2: the sender and the receiver open each file once for each chunk.
//!
//! Neither side holds a file handle between chunks. So a folder of hundreds of
//! files sends and receives at the soft limit of 256 open files on iOS and
//! macOS. Each sender open checks that the file did not change since the send
//! started.
//!
//! The sender tests use `Sink`, a receiver with no socket. The receiver and
//! round trip tests run the real sender and the real receiver over loopback
//! TCP. Each test with a low limit runs its body in a child process with
//! `ulimit -n 256`.

mod support;

use std::path::{Path, PathBuf};

use bytes::Bytes;
use daak_core::framing::{Frame, RecordType};
use daak_core::manifest::{
    from_picked_paths, Item, Manifest, PayloadKind, CHUNK_SIZE_DEFAULT, CHUNK_SIZE_MIN,
};
use daak_core::net::{tcp, FrameTransport, CONTROL_STREAM};
use daak_core::store::Db;
use daak_core::transfer::{receive_transfer, send_transfer};
use daak_core::CoreError;
use support::{
    bytes_of_len, db, file_bytes, folder, in_child, read_resume, resumed_pass,
    run_in_child_with_nofile, send_chunk, send_without_resume_frame, sender_ref, Sink, CHUNK,
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

/// Pin: this test passes before and after F2. A picked path that is a symlink
/// to a file still sends. The sender resolves the path at schedule time. It
/// opens the resolved file for each chunk.
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

/// Make the folder `name` under `src` with one file for each pair of a file
/// name and its bytes. Returns the folder path.
fn picked_folder(src: &Path, name: &str, files: &[(String, Vec<u8>)]) -> PathBuf {
    let root = src.join(name);
    std::fs::create_dir_all(&root).unwrap();
    for (file, bytes) in files {
        std::fs::write(root.join(file), bytes).unwrap();
    }
    root
}

/// Each item file under `dst` must hold the bytes of its source file.
fn assert_each_item_arrived(manifest: &Manifest, sources: &[PathBuf], src: &Path, dst: &Path) {
    for (item, source) in manifest.items.iter().zip(sources) {
        let rel = source.strip_prefix(src).unwrap();
        assert_eq!(
            std::fs::read(dst.join(rel)).unwrap(),
            std::fs::read(source).unwrap(),
            "item {} has the wrong bytes",
            item.index
        );
    }
    assert!(!dst.join("quarantine").exists(), "no quarantine");
}

/// Every item row is `done`.
fn assert_rows_done(db: &Db, manifest: &Manifest) {
    for item in &manifest.items {
        let row = db.get_item(&manifest.payload_id, item.index).unwrap();
        assert_eq!(row.unwrap().state, "done", "item {}", item.index);
    }
}

/// The receiver holds no file handle between chunks. A folder of 600 files and
/// 3 empty files goes through the real sender and the real receiver at 256
/// open files. A receiver that holds one handle for each item fails with "too
/// many open files".
#[tokio::test]
async fn a_folder_of_600_files_and_3_empty_files_round_trips_at_256_open_files() {
    if !in_child() {
        run_in_child_with_nofile(
            256,
            "a_folder_of_600_files_and_3_empty_files_round_trips_at_256_open_files",
        );
        return;
    }
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let mut files: Vec<(String, Vec<u8>)> = (0..600u32)
        .map(|i| {
            (
                format!("f{i:03}.bin"),
                bytes_of_len(i as u8, 100 + i as usize),
            )
        })
        .collect();
    files.extend((0..3).map(|i| (format!("empty{i}.bin"), Vec::new())));
    let root = picked_folder(src.path(), "many", &files);
    let (manifest, sources) = from_picked_paths(sender_ref(), &[root], CHUNK_SIZE_MIN).unwrap();
    assert_eq!(manifest.items.len(), 603);
    let paths: Vec<Option<PathBuf>> = sources.iter().cloned().map(Some).collect();
    let db = db();

    let (_, r, _) = resumed_pass(&manifest, &paths, dst.path(), &db).await;
    r.unwrap();

    assert_each_item_arrived(&manifest, &sources, src.path(), dst.path());
    for i in 0..3 {
        let meta = std::fs::metadata(dst.path().join(format!("many/empty{i}.bin"))).unwrap();
        assert_eq!(meta.len(), 0, "empty file {i} has size 0");
    }
    assert_rows_done(&db, &manifest);
}

/// One interrupted receive: items below `done` arrive in full. The other items
/// get only chunk 0. Then the connection drops.
async fn interrupted_at(
    manifest: &Manifest,
    paths: &[Option<PathBuf>],
    dst: &Path,
    db: &Db,
    done: u32,
) {
    let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let m = manifest.clone();
    let p = paths.to_vec();
    let dropper = tokio::spawn(async move {
        let (mut conn, _) = tcp::accept(&listener).await.unwrap();
        conn.send(
            CONTROL_STREAM,
            RecordType::Manifest,
            Bytes::from(m.to_cbor().unwrap()),
        )
        .await
        .unwrap();
        let _ = read_resume(&mut conn).await;
        for item in &m.items {
            let bytes = std::fs::read(p[item.index as usize].as_ref().unwrap()).unwrap();
            let count = if item.index < done {
                item.chunk_count.unwrap()
            } else {
                1
            };
            for c in 0..count {
                send_chunk(&mut conn, item.index, c, &bytes).await;
            }
        }
    });
    let mut conn = tcp::dial(addr).await.unwrap();
    let first = receive_transfer(&mut conn, dst, |_| {}, Some(db), |_| {}).await;
    dropper.await.unwrap();
    assert!(
        matches!(first, Err(CoreError::TransferInterrupted)),
        "a drop is an interrupt, got {first:?}"
    );
}

/// A receive of 300 files of 2 chunks stops. Items 0 to 149 are complete.
/// Items 150 to 299 hold chunk 0 only. Both passes run at 256 open files. The resume
/// sends only the missing chunks and gives correct bytes and no quarantine.
#[tokio::test]
async fn a_resume_with_done_and_partial_files_works_at_256_open_files() {
    if !in_child() {
        run_in_child_with_nofile(
            256,
            "a_resume_with_done_and_partial_files_works_at_256_open_files",
        );
        return;
    }
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let files: Vec<(String, Vec<u8>)> = (0..300u32)
        .map(|i| {
            let bytes = bytes_of_len(i as u8, CHUNK + 1 + i as usize);
            (format!("f{i:03}.bin"), bytes)
        })
        .collect();
    let root = picked_folder(src.path(), "many", &files);
    let (manifest, sources) = from_picked_paths(sender_ref(), &[root], CHUNK_SIZE_MIN).unwrap();
    assert_eq!(manifest.items.len(), 300);
    assert!(manifest.items.iter().all(|i| i.chunk_count == Some(2)));
    let paths: Vec<Option<PathBuf>> = sources.iter().cloned().map(Some).collect();
    let db = db();

    interrupted_at(&manifest, &paths, dst.path(), &db, 150).await;
    // An item row becomes `done` only at the end of a receive. After the drop,
    // the bitmaps record which items are complete and which are partial.
    for item in &manifest.items {
        let bitmap = db.load_bitmap(&manifest.payload_id, item.index, 2).unwrap();
        assert!(bitmap.is_set(0), "item {} holds chunk 0", item.index);
        let full = bitmap.is_set(1);
        assert_eq!(full, item.index < 150, "item {} after the drop", item.index);
    }

    let (sent, r, _) = resumed_pass(&manifest, &paths, dst.path(), &db).await;
    r.unwrap();
    for item in &manifest.items {
        let want = if item.index < 150 {
            0
        } else {
            item.size.unwrap() - CHUNK as u64
        };
        let got = sent.get(&item.index).copied().unwrap_or(0);
        assert_eq!(got, want, "item {} bytes on the wire", item.index);
    }
    assert_each_item_arrived(&manifest, &sources, src.path(), dst.path());
    assert_rows_done(&db, &manifest);
}

/// An empty folder holds no file, so it adds no item. The receiver does not
/// make it. A folder of only empty files arrives as files of size 0. An empty
/// folder alone is "nothing to send".
#[tokio::test]
async fn an_empty_folder_and_a_folder_of_only_empty_files_round_trip() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let empty = picked_folder(src.path(), "nothing", &[]);
    let files: Vec<(String, Vec<u8>)> = (0..3).map(|i| (format!("e{i}.bin"), Vec::new())).collect();
    let zeros = picked_folder(src.path(), "zeros", &files);

    let alone = from_picked_paths(sender_ref(), std::slice::from_ref(&empty), CHUNK_SIZE_MIN);
    assert!(
        matches!(alone, Err(CoreError::Transfer(_))),
        "got {alone:?}"
    );

    let (manifest, sources) =
        from_picked_paths(sender_ref(), &[empty, zeros], CHUNK_SIZE_MIN).unwrap();
    assert_eq!(manifest.items.len(), 3);
    let paths: Vec<Option<PathBuf>> = sources.iter().cloned().map(Some).collect();
    let db = db();

    let (sent, r, _) = resumed_pass(&manifest, &paths, dst.path(), &db).await;
    r.unwrap();
    assert!(sent.values().all(|n| *n == 0), "no chunk bytes: {sent:?}");
    for i in 0..3 {
        let meta = std::fs::metadata(dst.path().join(format!("zeros/e{i}.bin"))).unwrap();
        assert!(meta.is_file());
        assert_eq!(meta.len(), 0, "empty file {i} has size 0");
    }
    assert!(
        !dst.path().join("nothing").exists(),
        "an empty folder adds nothing"
    );
    assert_rows_done(&db, &manifest);
}

/// Pin: this test passes before and after F2. A version 100 sender reads no
/// resume frame. It sends every chunk, and this receiver accepts every chunk.
#[tokio::test]
async fn a_version_100_sender_against_this_receiver_round_trips() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let (manifest, paths) = folder(src.path());
    let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let m = manifest.clone();
    let p = paths.clone();
    let sender = tokio::spawn(async move {
        let (mut conn, _) = tcp::accept(&listener).await.unwrap();
        send_transfer(&mut conn, &m, &p, &[], |_| {}).await
    });
    let db = db();
    let mut conn = tcp::dial(addr).await.unwrap();
    receive_transfer(&mut conn, dst.path(), |_| {}, Some(&db), |_| {})
        .await
        .unwrap();
    sender.await.unwrap().unwrap();
    for (name, seed) in [("a.bin", 1u8), ("b.bin", 2), ("c.bin", 3)] {
        let got = std::fs::read(dst.path().join("album").join(name)).unwrap();
        assert_eq!(got, file_bytes(seed), "{name}");
    }
    assert_rows_done(&db, &manifest);
}

/// The real receiver with the resume frame removed. This is the version 100
/// receiver shape on the wire.
struct NoResumeFrame<T>(T);

impl<T: FrameTransport + Send> FrameTransport for NoResumeFrame<T> {
    async fn send(
        &mut self,
        stream_id: u32,
        kind: RecordType,
        body: Bytes,
    ) -> daak_core::Result<()> {
        if kind == RecordType::Nack {
            return Ok(());
        }
        self.0.send(stream_id, kind, body).await
    }
    async fn recv(&mut self) -> daak_core::Result<Option<Frame>> {
        self.0.recv().await
    }
}

/// Pin: this test passes before and after F2. This sender waits for no resume
/// frame from a version 100 receiver. It sends every chunk, and every file
/// arrives.
#[tokio::test]
async fn this_sender_against_a_receiver_that_sends_no_resume_frame_round_trips() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let (manifest, paths) = folder(src.path());
    let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let m = manifest.clone();
    let sender = tokio::spawn(async move {
        let (mut conn, _) = tcp::accept(&listener).await.unwrap();
        send_without_resume_frame(&mut conn, &m, &paths, |_| {}).await
    });
    let db = db();
    let mut conn = NoResumeFrame(tcp::dial(addr).await.unwrap());
    receive_transfer(&mut conn, dst.path(), |_| {}, Some(&db), |_| {})
        .await
        .unwrap();
    sender.await.unwrap().unwrap();
    for (name, seed) in [("a.bin", 1u8), ("b.bin", 2), ("c.bin", 3)] {
        let got = std::fs::read(dst.path().join("album").join(name)).unwrap();
        assert_eq!(got, file_bytes(seed), "{name}");
    }
    assert_rows_done(&db, &manifest);
}
