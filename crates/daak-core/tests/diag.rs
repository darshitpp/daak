use daak_core::diag::{self, DebugState, RecentLog};
use std::io::Write;
use tracing_subscriber::fmt::MakeWriter;

fn put(ring: &RecentLog, text: &str) {
    let mut w = ring.make_writer();
    w.write_all(text.as_bytes()).unwrap();
}

#[test]
fn ring_keeps_the_newest_lines() {
    let ring = RecentLog::with_capacity(5, None);
    for i in 0..12 {
        put(&ring, &format!("line {i}\n"));
    }
    let lines = ring.snapshot();
    assert_eq!(lines.len(), 5);
    assert_eq!(lines.first().unwrap(), "line 7\n");
    assert_eq!(lines.last().unwrap(), "line 11\n");
}

#[test]
fn a_line_is_cut_at_512_bytes_on_a_char_boundary() {
    let ring = RecentLog::with_capacity(10, Some(512));
    // 'e' with an acute accent has 2 bytes. 511 ASCII bytes then 2-byte chars
    // put a char across the 512 byte limit.
    let long = format!("{}{}\n", "a".repeat(511), "\u{e9}".repeat(20));
    put(&ring, &long);
    let lines = ring.snapshot();
    assert_eq!(lines.len(), 1);
    let line = &lines[0];
    assert!(line.ends_with('\n'));
    let body = line.trim_end_matches('\n');
    assert_eq!(body.len(), 511);
    assert!(body.chars().all(|c| c == 'a'));
    // A short line stays whole.
    put(&ring, "short\n");
    assert_eq!(ring.snapshot()[1], "short\n");
}

#[test]
fn default_ring_has_no_line_limit() {
    let ring = RecentLog::default();
    put(&ring, &format!("{}\n", "b".repeat(5000)));
    assert_eq!(ring.snapshot()[0].len(), 5001);
    for i in 0..600 {
        put(&ring, &format!("n{i}\n"));
    }
    assert_eq!(ring.snapshot().len(), 512);
}

fn state(events: Vec<String>) -> DebugState {
    DebugState {
        version: "0.1.0".into(),
        device_id: "00".repeat(16),
        listen_addr: "127.0.0.1:0".into(),
        events,
    }
}

#[test]
fn render_matches_the_daakd_layout() {
    let body = diag::render("daakd", &state(vec!["daakd started".into()]));
    assert!(body.starts_with("=== daak debug bundle ===\ngenerated_at_ms: "));
    let at = |s: &str| body.find(s).unwrap_or_else(|| panic!("missing {s}"));
    assert!(at("=== version ===") < at("=== identity ==="));
    assert!(at("=== identity ===") < at("=== recent log ==="));
    assert!(body.contains("\n=== version ===\ndaakd 0.1.0\n"));
    assert!(body.contains(&format!("device_id: {}\n", "00".repeat(16))));
    assert!(body.contains("listen_addr: 127.0.0.1:0\n"));
    assert!(body.ends_with("=== recent log ===\ndaakd started\n"));
}

#[test]
fn render_capped_stays_under_256_kib_and_keeps_the_newest_line() {
    assert!(diag::init(None));
    let events: Vec<String> = (0..2000)
        .map(|i| format!("{i:04} {}\n", "x".repeat(500)))
        .collect();
    let body = diag::render_capped("daak", &state(events));
    assert!(body.len() <= diag::BUNDLE_MAX_BYTES);
    assert!(body.contains("1999 xxx"));
    assert!(!body.contains("0000 xxx"));
}

#[test]
fn init_twice_is_safe() {
    let first = diag::init(None);
    let second = diag::init(None);
    assert_eq!(first, second);
    assert_eq!(diag::capture_installed(), first);
    tracing::info!(target: "daak_core::test", "ring probe");
    assert!(diag::app_log()
        .snapshot()
        .iter()
        .any(|l| l.contains("ring probe")));
}
