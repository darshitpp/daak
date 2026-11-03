// Task 5: the apps ring holds no private data.
//
// The test installs the process-global subscriber with `diag::init`, so it is
// a separate test binary. It runs a loopback pairing, a text send, and a file
// send with known display names, a known file name, known content, and known
// key bytes. It then reads the ring and checks that none of them is in it, and
// that no logged id is longer than 8 hex characters.
//
// Binds loopback sockets, so it needs an unsandboxed run.

use daak_core::crypto::identity::import_from_store;
use daak_core::crypto::secret_store::MemorySecretStore;
use daak_core::diag;
use daak_core::engine::{Engine, EngineConfig};
use daak_core::manifest::{from_picked_paths, DeviceRef, Manifest, CHUNK_SIZE_DEFAULT};
use daak_core::pairing::PairMode;
use daak_core::store::Db;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

const HOST_NAME: &str = "Alice Privatehost";
const JOIN_NAME: &str = "Bob Privatejoiner";
const FILE_NAME: &str = "holiday-plan-secret.bin";
const FILE_MARK: &str = "FILECONTENTMARKER";
const TEXT_MARK: &str = "TEXTCONTENTMARKER";

/// The secret key bytes of one engine, as lowercase hex.
struct Secrets {
    static_hex: String,
    signing_hex: String,
}

/// Copied from `pairing_done.rs` (`engine_with_db`). It also returns the
/// secret key bytes before the identity moves into the engine.
async fn engine_with_db(name: &str, out: PathBuf) -> (Arc<Engine>, Arc<Db>, Secrets) {
    std::env::set_var("DAAK_MDNS_OFF_LAN", "1");
    let store = Arc::new(MemorySecretStore::default());
    let identity = import_from_store(store.as_ref()).unwrap();
    let secrets = Secrets {
        static_hex: hex::encode(identity.static_secret().to_bytes()),
        signing_hex: hex::encode(identity.signing_key().to_bytes()),
    };
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
    (Arc::new(e), db, secrets)
}

/// Copied from `paired_over_the_published_address_delivers.rs`.
async fn sent_done(db: &Db, id: [u8; 16]) {
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if db
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
}

/// The longest run of lowercase hex characters in `s`.
fn longest_hex_run(s: &str) -> usize {
    let mut best = 0;
    let mut run = 0;
    for c in s.chars() {
        if c.is_ascii_digit() || ('a'..='f').contains(&c) {
            run += 1;
            best = best.max(run);
        } else {
            run = 0;
        }
    }
    best
}

/// `true` when `line` logs the 6-digit `sas`. The first field is the time
/// stamp, and its microseconds can hold the same 6 digits, so the check skips
/// it. The SAS must be a whole digit run. A longer run, such as an all-digit
/// short id, is not the SAS.
fn logs_sas(line: &str, sas: &str) -> bool {
    let body = line
        .trim_start()
        .split_once(char::is_whitespace)
        .map_or("", |(_, rest)| rest);
    body.split(|c: char| !c.is_ascii_digit())
        .any(|run| run == sas)
}

#[test]
fn the_sas_check_skips_the_time_stamp_and_finds_a_logged_sas() {
    let sas = "123456";
    // The microseconds of the time stamp hold the same 6 digits.
    let stamp = "2026-10-23T08:45:12.123456Z  INFO daak_core::engine: paired";
    assert!(!logs_sas(stamp, sas));
    // A short id is 8 hex characters. An all-digit one is not the SAS.
    assert!(!logs_sas(
        "2026-10-23T08:45:12.000001Z  INFO peer=91234567",
        sas
    ));
    assert!(logs_sas(
        "2026-10-23T08:45:12.000001Z  INFO pairing sas=123456",
        sas
    ));
    assert!(logs_sas(
        "2026-10-23T08:45:12.000001Z  INFO code 123456 shown",
        sas
    ));
}

#[tokio::test]
async fn the_ring_holds_no_name_content_key_or_long_id() {
    assert!(diag::init(None), "this binary owns the global subscriber");

    let host_dir = tempfile::tempdir().unwrap();
    let join_dir = tempfile::tempdir().unwrap();
    let payload_dir = tempfile::tempdir().unwrap();
    let (host, _host_db, host_keys) =
        engine_with_db(HOST_NAME, host_dir.path().to_path_buf()).await;
    let (join, join_db, join_keys) = engine_with_db(JOIN_NAME, join_dir.path().to_path_buf()).await;

    let host_addr = host.local_addr();
    let host_bundle = host.pairing_bundle().await;
    let host_id = host_bundle.identity.device_id;

    host.offer_inbound_pairing(PairMode::Qr).await.unwrap();
    let accepted = tokio::spawn({
        let host = host.clone();
        async move { host.accept_pairing_once_with_peer().await.unwrap() }
    });
    let (sas, _) = join.pair_with(host_addr, host_bundle).await.unwrap();
    accepted.await.unwrap();

    let (join_name, join_id) = join.self_profile().await;
    let sender = DeviceRef {
        device_id: join_id,
        name: join_name,
    };

    let mut text = Manifest::text(TEXT_MARK);
    text.sender = sender.clone();
    let text_id = join
        .enqueue_outbox_send(host_id, text, vec![])
        .await
        .unwrap();
    sent_done(&join_db, text_id).await;

    let file = payload_dir.path().join(FILE_NAME);
    std::fs::write(&file, FILE_MARK.repeat(64)).unwrap();
    let (manifest, sources) = from_picked_paths(sender, &[file], CHUNK_SIZE_DEFAULT).unwrap();
    let file_id = join
        .enqueue_outbox_send(host_id, manifest, sources)
        .await
        .unwrap();
    sent_done(&join_db, file_id).await;

    // The receive span closes a little after the sender row moves to done.
    // Wait for the receive close line, so the check reads a full log.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let lines = loop {
        let lines = diag::app_log().snapshot();
        if lines
            .iter()
            .filter(|l| l.contains("receive{") && l.contains("close"))
            .count()
            >= 2
            || tokio::time::Instant::now() > deadline
        {
            break lines;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let log = lines.join("");

    // The check must read a real log. The spans name the peer with 8 hex
    // characters, so the short host id must be in the ring.
    let short_host = &hex::encode(host_id)[..8];
    assert!(
        log.contains(&format!("peer={short_host}")),
        "the ring holds no span with the short peer id. The ring holds:\n{log}"
    );

    let forbidden: Vec<(&str, String)> = vec![
        ("host display name", HOST_NAME.to_string()),
        ("joiner display name", JOIN_NAME.to_string()),
        ("file name", FILE_NAME.to_string()),
        ("file content", FILE_MARK.to_string()),
        ("text content", TEXT_MARK.to_string()),
        ("host static secret", host_keys.static_hex.clone()),
        ("host signing key", host_keys.signing_hex.clone()),
        ("joiner static secret", join_keys.static_hex.clone()),
        ("joiner signing key", join_keys.signing_hex.clone()),
        ("full host id", hex::encode(host_id)),
        ("full joiner id", hex::encode(join_id)),
        ("full text payload id", hex::encode(text_id)),
        ("full file payload id", hex::encode(file_id)),
    ];
    for (what, value) in &forbidden {
        assert!(
            !log.contains(value.as_str()),
            "the ring holds the {what}. The ring holds:\n{log}"
        );
    }
    for line in &lines {
        assert!(!logs_sas(line, &sas), "the ring holds the SAS: {line}");
        assert!(
            longest_hex_run(line) <= 8,
            "a logged id is longer than 8 hex characters: {line}"
        );
    }

    join.shutdown().await.unwrap();
    host.shutdown().await.unwrap();
}
