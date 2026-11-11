//! Task 2: retry end to end, through two real `Engine`s.
//!
//! A TCP proxy sits between engine A (the sender) and engine B (the receiver).
//! The proxy counts the bytes that A sends to B. It can cut the connection
//! after a set count, and it can refuse new connections. The traffic is
//! encrypted, so the proxy counts every byte, not only chunk bytes. Each
//! assertion therefore allows a small overhead that is much smaller than one
//! chunk.
//!
//! The sender interleaves the items, 1 chunk at a time. Files `a.bin` and
//! `c.bin` have 1 chunk each. File `b.bin` has 4 chunks. So the wire order is
//! a0, b0, c0, b1, b2, b3.

mod support;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use daak_core::engine::{Engine, EngineConfig, EngineEvent};
use daak_core::manifest::{from_picked_paths, DeviceRef, Manifest, CHUNK_SIZE_MIN};
use daak_core::pairing::PairMode;
use daak_core::store::inbox::InboxRow;
use daak_core::store::Db;
use daak_core::transfer::send_transfer;
use support::{bytes_of_len, db, file_bytes, folder, resumed_pass, CHUNK, FILE_LEN};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// The protocol overhead on one connection: the handshake, the hello, the
/// manifest, and the frame headers. It is much smaller than one chunk, so a
/// file that crosses the wire again is always visible.
const SLACK: u64 = 16 * 1024;

#[derive(Default)]
struct ProxyState {
    /// Bytes that A sent to B since the last reset.
    a_to_b: u64,
    /// Cut the connection when `a_to_b` reaches this count.
    cut_after: Option<u64>,
    /// Close each new connection at once.
    refuse: bool,
}

type Shared = Arc<Mutex<ProxyState>>;

async fn proxy(upstream: std::net::SocketAddr) -> (std::net::SocketAddr, Shared) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state: Shared = Arc::default();
    let st = state.clone();
    tokio::spawn(async move {
        loop {
            let Ok((a, _)) = listener.accept().await else {
                return;
            };
            if st.lock().unwrap().refuse {
                continue;
            }
            tokio::spawn(pipe(a, upstream, st.clone()));
        }
    });
    (addr, state)
}

async fn pipe(a: TcpStream, upstream: std::net::SocketAddr, st: Shared) {
    let Ok(b) = TcpStream::connect(upstream).await else {
        return;
    };
    let (mut ar, mut aw) = a.into_split();
    let (mut br, mut bw) = b.into_split();
    let back = tokio::spawn(async move {
        let _ = tokio::io::copy(&mut br, &mut aw).await;
    });
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let n = match ar.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let (take, cut) = {
            let mut s = st.lock().unwrap();
            let take = match s.cut_after {
                Some(k) => (k.saturating_sub(s.a_to_b) as usize).min(n),
                None => n,
            };
            s.a_to_b += take as u64;
            let cut = s.cut_after.is_some_and(|k| s.a_to_b >= k);
            if cut {
                s.cut_after = None;
                s.refuse = true;
            }
            (take, cut)
        };
        if bw.write_all(&buf[..take]).await.is_err() {
            break;
        }
        if cut {
            // Both sockets close here: the receiver sees a dropped connection.
            back.abort();
            return;
        }
    }
    let _ = bw.shutdown().await;
    let _ = back.await;
}

async fn engine(name: &str, out: PathBuf) -> (Arc<Engine>, Arc<Db>) {
    std::env::set_var("DAAK_MDNS_OFF_LAN", "1");
    let store = Arc::new(daak_core::crypto::secret_store::MemorySecretStore::default());
    let identity = daak_core::crypto::identity::import_from_store(store.as_ref()).unwrap();
    let db = Arc::new(Db::open_in_memory().unwrap());
    db.migrate().unwrap();
    let engine = Engine::start(EngineConfig {
        display_name: name.into(),
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        out_dir: out,
        identity,
        db: db.clone(),
    })
    .await
    .unwrap();
    (Arc::new(engine), db)
}

struct Pair {
    a: Arc<Engine>,
    a_db: Arc<Db>,
    b: Arc<Engine>,
    b_db: Arc<Db>,
    b_id: [u8; 16],
    proxy: Shared,
    a_out: tempfile::TempDir,
    b_out: tempfile::TempDir,
}

/// Two paired engines. A reaches B only through the proxy, and A knows that B
/// speaks the current protocol version (in production an mDNS announce says
/// this).
async fn pair() -> Pair {
    let a_out = tempfile::tempdir().unwrap();
    let b_out = tempfile::tempdir().unwrap();
    let (a, a_db) = engine("a", a_out.path().to_path_buf()).await;
    let (b, b_db) = engine("b", b_out.path().to_path_buf()).await;
    let b_id = b.pairing_bundle().await.identity.device_id;
    b.offer_pairing(a.pairing_bundle().await, PairMode::Qr, None)
        .await
        .unwrap();
    let b_srv = b.clone();
    let server = tokio::spawn(async move { b_srv.accept_pairing_once().await.unwrap() });
    a.pair_with(b.local_addr(), b.pairing_bundle().await)
        .await
        .unwrap();
    server.await.unwrap();
    let (proxy_addr, proxy) = proxy(b.local_addr()).await;
    a.note_peer(b_id, "b", proxy_addr).await;
    a.note_peer_version(b_id, daak_core::discovery::mdns::PROTO_VERSION);
    Pair {
        a,
        a_db,
        b,
        b_db,
        b_id,
        proxy,
        a_out,
        b_out,
    }
}

/// `album/` with `a.bin` (1 chunk), `b.bin` (4 chunks), and `c.bin` (1 chunk).
fn mixed_folder(src: &Path, sender: [u8; 16]) -> (Manifest, Vec<PathBuf>) {
    let root = src.join("album");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("a.bin"), bytes_of_len(1, CHUNK)).unwrap();
    std::fs::write(root.join("b.bin"), file_bytes(2)).unwrap();
    std::fs::write(root.join("c.bin"), bytes_of_len(3, CHUNK)).unwrap();
    let me = DeviceRef {
        device_id: sender,
        name: "a".into(),
    };
    let (manifest, sources) = from_picked_paths(me, &[root], CHUNK_SIZE_MIN).unwrap();
    let names: Vec<_> = manifest.items.iter().map(|i| i.name.clone()).collect();
    assert!(
        names[1].as_deref().unwrap().contains("b.bin"),
        "item 1 is b.bin: {names:?}"
    );
    (manifest, sources)
}

fn expected(name: &str) -> Vec<u8> {
    match name {
        "a.bin" => bytes_of_len(1, CHUNK),
        "b.bin" => file_bytes(2),
        _ => bytes_of_len(3, CHUNK),
    }
}

async fn wait_until(what: &str, mut ok: impl FnMut() -> bool) {
    for _ in 0..1500 {
        if ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out: {what}");
}

fn outbox_state(db: &Db, id: &[u8; 16]) -> (String, u32) {
    let row = db.get_outbox(id).unwrap().unwrap();
    (row.state, row.attempts)
}

fn inbox_paths(db: &Db, id: &[u8; 16]) -> Vec<String> {
    db.list_inbox()
        .unwrap()
        .into_iter()
        .find(|r| r.id == *id)
        .map(|r| parse_paths(&r.saved_paths))
        .unwrap_or_default()
}

/// The test paths hold no quote and no backslash, so a split is enough.
fn parse_paths(json: &str) -> Vec<String> {
    let inner = json.trim().trim_start_matches('[').trim_end_matches(']');
    inner
        .split(',')
        .map(|s| s.trim().trim_matches('"').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Wait for the `TransferDone` of `id` on B. B sends it after it writes the
/// inbox row. Returns every event before it.
async fn b_done(
    rx: &mut tokio::sync::broadcast::Receiver<EngineEvent>,
    id: [u8; 16],
) -> Vec<EngineEvent> {
    let mut seen = Vec::new();
    let r = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            match rx.recv().await {
                Ok(EngineEvent::TransferDone { transfer_id }) if transfer_id == id => return,
                Ok(ev) => seen.push(ev),
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(e) => panic!("event channel closed: {e}"),
            }
        }
    })
    .await;
    r.expect("B did not finish the transfer");
    seen
}

/// Send the folder, cut the connection after `cut` bytes, then call
/// `Engine::retry`. Returns the bytes that A sent to B after the retry.
async fn drop_then_retry(p: &Pair, cut: u64) -> ([u8; 16], u64) {
    let src = tempfile::tempdir().unwrap();
    let (manifest, sources) = mixed_folder(src.path(), [0u8; 16]);
    p.proxy.lock().unwrap().cut_after = Some(cut);
    let id =
        p.a.enqueue_outbox_send(p.b_id, manifest, sources)
            .await
            .unwrap();

    // The cut, then the re-dial inside the same drain fails on the refused
    // connection. The row goes back to pending with a backoff.
    wait_until("the first drain fails", || {
        let (state, attempts) = outbox_state(&p.a_db, &id);
        state == "pending" && attempts >= 1
    })
    .await;
    // B saved what it holds when the connection dropped.
    wait_until("B saves its chunk bitmap", || {
        p.b_db.load_bitmap(&id, 0, 1).unwrap().is_complete()
    })
    .await;

    let mut rx = p.b.events();
    {
        let mut s = p.proxy.lock().unwrap();
        s.a_to_b = 0;
        s.refuse = false;
    }
    p.a.retry(id).unwrap();
    b_done(&mut rx, id).await;
    wait_until("A settles the row", || {
        outbox_state(&p.a_db, &id).0 == "done"
    })
    .await;
    for name in ["a.bin", "b.bin", "c.bin"] {
        assert_eq!(
            std::fs::read(p.b_out.path().join("album").join(name)).unwrap(),
            expected(name),
            "{name} is complete on B"
        );
    }
    let after = p.proxy.lock().unwrap().a_to_b;
    (id, after)
}

#[tokio::test]
async fn retry_sends_only_the_failed_files() {
    let p = pair().await;
    // a0, b0, c0, and b1 cross the wire. The cut is inside b2.
    let (id, after) = drop_then_retry(&p, (4 * CHUNK + CHUNK / 2) as u64).await;
    // b.bin needs chunks 2 and 3 only. a.bin and c.bin need nothing.
    let missing = (FILE_LEN - 2 * CHUNK) as u64;
    assert!(
        (missing..missing + SLACK).contains(&after),
        "after the retry, A sends only the missing chunks of b.bin \
         ({missing} bytes and overhead), got {after}"
    );
    assert_eq!(inbox_paths(&p.b_db, &id).len(), 3);
    p.a.shutdown().await.unwrap();
    p.b.shutdown().await.unwrap();
}

#[tokio::test]
async fn the_inbox_received_event_carries_the_roots_before_the_move() {
    let p = pair().await;
    let src = tempfile::tempdir().unwrap();
    let (manifest, sources) = mixed_folder(src.path(), [0u8; 16]);
    let mut rx = p.b.events();
    let id =
        p.a.enqueue_outbox_send(p.b_id, manifest, sources)
            .await
            .unwrap();
    let events = b_done(&mut rx, id).await;
    let root = p.b_out.path().join("album").to_string_lossy().to_string();
    let told: Vec<&InboxRow> = events
        .iter()
        .filter_map(|e| match e {
            EngineEvent::InboxReceived(r) if r.id == id => Some(r),
            _ => None,
        })
        .collect();
    assert_eq!(told.len(), 1, "one event");
    assert_eq!(told[0].group_roots, vec![root.clone()]);
    let listed = p.b.list_inbox().unwrap();
    assert_eq!(listed[0].group_roots, vec![root]);

    // The platform moves the files to the library. The paths are no longer
    // file system paths, so a later list names no root.
    let moved: Vec<String> = (0..3).map(|i| format!("photos:{i}")).collect();
    p.b_db.replace_inbox_paths(&id, &moved).unwrap();
    assert!(p.b.list_inbox().unwrap()[0].group_roots.is_empty());
    p.a.shutdown().await.unwrap();
    p.b.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_resumed_folder_lists_every_file_in_its_inbox_row() {
    let p = pair().await;
    // Only a0 crosses the wire. The cut is inside b0.
    let (id, after) = drop_then_retry(&p, (CHUNK + CHUNK / 2) as u64).await;
    let missing = (FILE_LEN + CHUNK) as u64;
    assert!(
        (missing..missing + SLACK).contains(&after),
        "a.bin does not cross the wire again, got {after}"
    );
    let paths = inbox_paths(&p.b_db, &id);
    for name in ["a.bin", "b.bin", "c.bin"] {
        assert!(
            paths.iter().any(|s| s.ends_with(&format!("album/{name}"))),
            "the inbox row lists {name}: {paths:?}"
        );
    }
    assert_eq!(paths.len(), 3, "{paths:?}");
    p.a.shutdown().await.unwrap();
    p.b.shutdown().await.unwrap();
}

#[tokio::test]
async fn retry_resends_a_file_that_failed_its_hash() {
    let p = pair().await;
    let src = tempfile::tempdir().unwrap();
    let (manifest, sources) = mixed_folder(src.path(), [0u8; 16]);
    // Change b.bin after the manifest has its hash. The staged copy is then
    // wrong, so B quarantines item 1.
    let mut wrong = file_bytes(2);
    wrong[5] ^= 0xff;
    std::fs::write(&sources[1], &wrong).unwrap();
    let mut rx = p.b.events();
    let id =
        p.a.enqueue_outbox_send(p.b_id, manifest, sources)
            .await
            .unwrap();
    b_done(&mut rx, id).await;
    wait_until("the quarantine fails the row", || {
        outbox_state(&p.a_db, &id).0 == "failed"
    })
    .await;
    assert_eq!(
        p.b_db.get_item(&id, 1).unwrap().unwrap().state,
        "quarantined"
    );
    let slot = p
        .b_out
        .path()
        .join("quarantine")
        .join(hex::encode(id))
        .join("b.bin");
    assert!(slot.exists(), "B holds the bad copy at {slot:?}");
    assert_eq!(inbox_paths(&p.b_db, &id).len(), 2, "a.bin and c.bin only");

    // Repair the staged copy, then retry. Staging names each copy
    // `item_<index>`, and b.bin is item 1.
    let staged_dir = p.a_out.path().join("staging").join(hex::encode(id));
    std::fs::write(staged_dir.join("item_1"), file_bytes(2)).unwrap();
    p.proxy.lock().unwrap().a_to_b = 0;
    p.a.retry(id).unwrap();
    let events = b_done(&mut rx, id).await;
    wait_until("A settles the row", || {
        outbox_state(&p.a_db, &id).0 == "done"
    })
    .await;

    let after = p.proxy.lock().unwrap().a_to_b;
    let len = FILE_LEN as u64;
    assert!(
        (len..len + SLACK).contains(&after),
        "only b.bin crosses the wire again, got {after}"
    );
    let item = p.b_db.get_item(&id, 1).unwrap().unwrap();
    assert_eq!(item.state, "done");
    let new_path = item.dest_path.unwrap();
    assert!(new_path.ends_with("album/b.bin"), "{new_path}");
    assert_eq!(std::fs::read(&new_path).unwrap(), file_bytes(2));

    let paths = inbox_paths(&p.b_db, &id);
    assert!(
        paths.contains(&new_path),
        "the inbox row lists the new path of b.bin: {paths:?}"
    );
    assert_eq!(paths.len(), 3, "{paths:?}");
    let told: Vec<&InboxRow> = events
        .iter()
        .filter_map(|e| match e {
            EngineEvent::InboxReceived(r) if r.id == id => Some(r),
            _ => None,
        })
        .collect();
    assert!(
        told.iter().any(|r| r.saved_paths.contains("album/b.bin")),
        "the UI hears of the new path: {told:?}"
    );
    assert!(!slot.exists(), "the held copy is deleted: {slot:?}");
    p.a.shutdown().await.unwrap();
    p.b.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_100_sender_against_a_101_receiver_with_a_done_item_finishes() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let (manifest, paths) = folder(src.path());
    let db = db();

    // Connection 1: b.bin is wrong, so the receiver quarantines item 1. Items
    // 0 and 2 are done.
    let bad_dir = tempfile::tempdir().unwrap();
    let bad = bad_dir.path().join("b.bin");
    let mut wrong = file_bytes(2);
    wrong[5] ^= 0xff;
    std::fs::write(&bad, &wrong).unwrap();
    let mut bad_paths = paths.clone();
    bad_paths[1] = Some(bad);
    let (_, r, _) = resumed_pass(&manifest, &bad_paths, dst.path(), &db).await;
    assert!(matches!(
        r,
        Err(daak_core::CoreError::Quarantined { item_index: 1, .. })
    ));
    db.add_inbox_once(&InboxRow {
        id: manifest.payload_id,
        transfer_id: manifest.payload_id,
        peer_device_id: manifest.sender.device_id,
        kind: "batch".into(),
        item_count: 3,
        summary: "3 file(s)".into(),
        received_at: 0,
        saved_paths: "[]".into(),
        group_roots: Vec::new(),
        share: None,
        batch: None,
    })
    .unwrap();

    // A version 100 sender sends every chunk and does not read the resume
    // frame. The receiver can finish and close before the sender stops, so
    // the first attempt can fail. A second attempt must then finish.
    let mut finished = false;
    for _ in 0..2 {
        let (listener, addr) = daak_core::net::tcp::bind("127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
        let m = manifest.clone();
        let p = paths.clone();
        let sender = tokio::spawn(async move {
            let (mut conn, _) = daak_core::net::tcp::accept(&listener).await.unwrap();
            send_transfer(&mut conn, &m, &p, &[], |_| {}).await
        });
        let mut conn = daak_core::net::tcp::dial(addr).await.unwrap();
        let recv = tokio::time::timeout(
            Duration::from_secs(20),
            daak_core::transfer::receive_transfer(&mut conn, dst.path(), |_| {}, Some(&db), |_| {}),
        )
        .await
        .expect("the receive hung");
        drop(conn);
        let sent = sender.await.unwrap();
        if recv.is_ok() && sent.is_ok() {
            finished = true;
            break;
        }
    }
    assert!(finished, "the first or the second attempt finishes");
    for (i, (name, seed)) in [("a.bin", 1u8), ("b.bin", 2), ("c.bin", 3)]
        .iter()
        .enumerate()
    {
        assert_eq!(
            std::fs::read(dst.path().join("album").join(name)).unwrap(),
            file_bytes(*seed),
            "{name} is not lost"
        );
        assert_eq!(
            db.get_item(&manifest.payload_id, i as u32)
                .unwrap()
                .unwrap()
                .state,
            "done"
        );
    }
}

#[tokio::test]
async fn staging_survives_deletion_of_the_source() {
    let p = pair().await;
    // The peer is unreachable, so the first drain cannot read the source.
    p.proxy.lock().unwrap().refuse = true;
    let src = tempfile::tempdir().unwrap();
    let (manifest, sources) = mixed_folder(src.path(), [0u8; 16]);
    let id =
        p.a.enqueue_outbox_send(p.b_id, manifest, sources)
            .await
            .unwrap();
    std::fs::remove_dir_all(src.path().join("album")).unwrap();
    wait_until("the first drain fails", || {
        let (state, attempts) = outbox_state(&p.a_db, &id);
        state == "pending" && attempts >= 1
    })
    .await;

    let mut rx = p.b.events();
    p.proxy.lock().unwrap().refuse = false;
    p.a.retry(id).unwrap();
    b_done(&mut rx, id).await;
    wait_until("A settles the row", || {
        outbox_state(&p.a_db, &id).0 == "done"
    })
    .await;
    for name in ["a.bin", "b.bin", "c.bin"] {
        assert_eq!(
            std::fs::read(p.b_out.path().join("album").join(name)).unwrap(),
            expected(name),
            "B gets every byte of {name}"
        );
    }
    p.a.shutdown().await.unwrap();
    p.b.shutdown().await.unwrap();
}

/// Pin: this test passes on the old code. It guards the retry of a folder and
/// of a loose file.
#[tokio::test]
async fn the_outbox_retry_resumes_for_a_folder_and_for_a_loose_file() {
    let p = pair().await;
    // The folder: a0, b0, c0, and b1 cross the wire. The cut is inside b2.
    let (_, after) = drop_then_retry(&p, (4 * CHUNK + CHUNK / 2) as u64).await;
    let missing = (FILE_LEN - 2 * CHUNK) as u64;
    assert!(
        (missing..missing + SLACK).contains(&after),
        "the folder retry sends only the missing chunks, got {after}"
    );

    // The loose file: chunks 0 and 1 cross the wire. The cut is inside chunk 2.
    let src = tempfile::tempdir().unwrap();
    let file = src.path().join("loose.bin");
    std::fs::write(&file, file_bytes(4)).unwrap();
    let me = DeviceRef {
        device_id: [0u8; 16],
        name: "a".into(),
    };
    let (manifest, sources) =
        from_picked_paths(me, std::slice::from_ref(&file), CHUNK_SIZE_MIN).unwrap();
    {
        let mut s = p.proxy.lock().unwrap();
        s.a_to_b = 0;
        s.cut_after = Some((2 * CHUNK + CHUNK / 2) as u64);
    }
    let id =
        p.a.enqueue_outbox_send(p.b_id, manifest, sources)
            .await
            .unwrap();
    wait_until("the first drain fails", || {
        let (state, attempts) = outbox_state(&p.a_db, &id);
        state == "pending" && attempts >= 1
    })
    .await;
    wait_until("B saves its chunk bitmap", || {
        p.b_db.load_bitmap(&id, 0, 4).unwrap().is_set(1)
    })
    .await;

    let mut rx = p.b.events();
    {
        let mut s = p.proxy.lock().unwrap();
        s.a_to_b = 0;
        s.refuse = false;
    }
    p.a.retry(id).unwrap();
    b_done(&mut rx, id).await;
    wait_until("A settles the row", || {
        outbox_state(&p.a_db, &id).0 == "done"
    })
    .await;
    assert_eq!(
        std::fs::read(p.b_out.path().join("loose.bin")).unwrap(),
        file_bytes(4)
    );
    let after = p.proxy.lock().unwrap().a_to_b;
    assert!(
        (missing..missing + SLACK).contains(&after),
        "the loose file retry sends only chunks 2 and 3, got {after}"
    );
    p.a.shutdown().await.unwrap();
    p.b.shutdown().await.unwrap();
}

/// F4: B already has a folder `album`. The received folder takes `album-1`.
/// Every report names `album-1`: the item events, the inbox paths, the group
/// roots, and the thread items. The old folder stays as it is.
#[tokio::test]
async fn a_folder_received_into_an_out_dir_that_has_album_reports_album_dash_1_everywhere() {
    let p = pair().await;
    let old = p.b_out.path().join("album");
    std::fs::create_dir(&old).unwrap();
    std::fs::write(old.join("keep.txt"), b"keep").unwrap();
    let src = tempfile::tempdir().unwrap();
    let (manifest, sources) = mixed_folder(src.path(), [0u8; 16]);
    let mut rx = p.b.events();
    let id =
        p.a.enqueue_outbox_send(p.b_id, manifest, sources)
            .await
            .unwrap();
    let events = b_done(&mut rx, id).await;

    let root = p.b_out.path().join("album-1");
    let root_text = root.to_string_lossy().to_string();
    let item_paths: Vec<String> = events
        .iter()
        .filter_map(|e| match e {
            EngineEvent::TransferItem {
                transfer_id,
                dest_path,
                ..
            } if *transfer_id == id => dest_path.clone(),
            _ => None,
        })
        .collect();
    assert_eq!(item_paths.len(), 3, "{item_paths:?}");
    for path in &item_paths {
        assert!(Path::new(path).starts_with(&root), "item event: {path}");
    }
    let told: Vec<&InboxRow> = events
        .iter()
        .filter_map(|e| match e {
            EngineEvent::InboxReceived(r) if r.id == id => Some(r),
            _ => None,
        })
        .collect();
    assert_eq!(told.len(), 1, "one event");
    assert_eq!(told[0].group_roots, vec![root_text.clone()]);
    let saved = inbox_paths(&p.b_db, &id);
    assert_eq!(saved.len(), 3, "{saved:?}");
    for path in &saved {
        assert!(Path::new(path).starts_with(&root), "saved path: {path}");
    }
    let listed = p.b.list_inbox().unwrap();
    let row = listed.iter().find(|r| r.id == id).unwrap();
    assert_eq!(row.group_roots, vec![root_text]);

    let a_id = p.a.pairing_bundle().await.identity.device_id;
    let page = p.b.list_thread(a_id, 50, None).unwrap();
    let thread_paths: Vec<&String> = page
        .items
        .iter()
        .filter(|i| i.transfer_id == id)
        .filter_map(|i| i.dest_path.as_ref())
        .collect();
    assert_eq!(thread_paths.len(), 3, "{thread_paths:?}");
    for path in thread_paths {
        assert!(Path::new(path).starts_with(&root), "thread item: {path}");
    }
    for name in ["a.bin", "b.bin", "c.bin"] {
        assert_eq!(std::fs::read(root.join(name)).unwrap(), expected(name));
    }
    assert_eq!(std::fs::read(old.join("keep.txt")).unwrap(), b"keep");
    assert_eq!(std::fs::read_dir(&old).unwrap().count(), 1, "no merge");
    p.a.shutdown().await.unwrap();
    p.b.shutdown().await.unwrap();
}
