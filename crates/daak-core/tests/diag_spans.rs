// Task 5: each timed operation writes one close line to the apps ring.
//
// The test installs the process-global subscriber with `diag::init`, so it is
// a separate test binary. It runs a loopback pairing and one small file
// transfer between two engines. It then reads the ring and finds one close
// line, with a `time.busy` field, for each span name.
//
// Binds loopback sockets, so it needs an unsandboxed run.

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::diag;
use daak_core::engine::{Engine, EngineConfig};
use daak_core::manifest::{from_picked_paths, DeviceRef, CHUNK_SIZE_DEFAULT};
use daak_core::pairing::PairMode;
use daak_core::store::Db;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// Copied from `pairing_done.rs` (`engine_with_db`). The bind is loopback, and
/// the mDNS switch keeps the engine off the LAN.
async fn engine_with_db(name: &str, out: PathBuf) -> (Arc<Engine>, Arc<Db>) {
    std::env::set_var("DAAK_MDNS_OFF_LAN", "1");
    let store = Arc::new(MemorySecretStore::default());
    let identity = import_from_store(store.as_ref()).unwrap();
    let db = Arc::new(Db::open_in_memory().unwrap());
    db.migrate().unwrap();
    let e = Engine::start(EngineConfig {
        display_name: name.into(),
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        out_dir: out,
        identity,
        db: db.clone(),
    })
    .await
    .unwrap();
    (Arc::new(e), db)
}

/// The innermost span of a formatted line. The fmt layer writes the span
/// context, then `: `, then the target. A field value never holds `:`.
fn innermost_span(line: &str) -> Option<&str> {
    let ctx = &line[..line.find(" daak_core")?];
    let ctx = ctx.trim_end().trim_end_matches(':');
    let mut depth = 0i32;
    let mut start = 0;
    for (i, c) in ctx.char_indices() {
        match c {
            '{' => depth += 1,
            '}' => depth -= 1,
            ':' if depth == 0 => start = i + 1,
            _ => {}
        }
    }
    let last = &ctx[start..];
    let name = last.split('{').next()?;
    name.split_whitespace().last()
}

fn closed(lines: &[String], name: &str) -> bool {
    lines
        .iter()
        .any(|l| l.contains("close") && l.contains("time.busy") && innermost_span(l) == Some(name))
}

#[tokio::test]
async fn pairing_and_transfer_write_a_close_line_for_each_span() {
    assert!(diag::init(None), "this binary owns the global subscriber");

    let host_dir = tempfile::tempdir().unwrap();
    let join_dir = tempfile::tempdir().unwrap();
    let payload_dir = tempfile::tempdir().unwrap();
    let (host, _host_db) = engine_with_db("host", host_dir.path().to_path_buf()).await;
    let (join, join_db) = engine_with_db("joiner", join_dir.path().to_path_buf()).await;

    let host_addr = host.local_addr();
    let host_bundle = host.pairing_bundle().await;
    let host_id = host_bundle.identity.device_id;

    host.offer_inbound_pairing(PairMode::Qr).await.unwrap();
    let accepted = tokio::spawn({
        let host = host.clone();
        async move { host.accept_pairing_once_with_peer().await.unwrap() }
    });
    join.pair_with(host_addr, host_bundle).await.unwrap();
    accepted.await.unwrap();

    let (join_name, join_id) = join.self_profile().await;
    let file = payload_dir.path().join("span.bin");
    std::fs::write(&file, vec![7u8; 4096]).unwrap();
    let (manifest, sources) = from_picked_paths(
        DeviceRef {
            device_id: join_id,
            name: join_name,
        },
        &[file],
        CHUNK_SIZE_DEFAULT,
    )
    .unwrap();
    let id = join
        .enqueue_outbox_send(host_id, manifest, sources)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if join_db
                .get_outbox(&id)
                .unwrap()
                .is_some_and(|r| r.state == "done")
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the send never reached done");

    // The receive span and the drain span close a little after the row moves
    // to done. Wait for the lines, with a limit.
    let names = [
        "pairing",
        "pairing_commit",
        "inbound",
        "handshake",
        "send",
        "receive",
        "outbox_drain",
    ];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let lines = diag::app_log().snapshot();
        let missing: Vec<&str> = names
            .iter()
            .copied()
            .filter(|n| !closed(&lines, n))
            .collect();
        if missing.is_empty() {
            break;
        }
        if tokio::time::Instant::now() > deadline {
            panic!(
                "no close line for {missing:?}. The ring holds:\n{}",
                lines.join("")
            );
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    join.shutdown().await.unwrap();
    host.shutdown().await.unwrap();
}
