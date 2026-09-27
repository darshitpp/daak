#[test]
fn exported_debug_bundle_is_non_empty_and_has_section_headers() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("debug-bundle.txt");

    let state = daakd::debug_bundle::DebugState {
        version: "0.1.0".into(),
        device_id: "00".repeat(16),
        listen_addr: "127.0.0.1:0".into(),
        events: vec![
            "2026-09-14T00:00:00Z INFO daakd started".to_string(),
            "2026-09-14T00:00:01Z INFO listener bound".to_string(),
        ],
    };
    daakd::debug_bundle::export(&path, &state).unwrap();

    let body = std::fs::read_to_string(&path).unwrap();
    assert!(!body.trim().is_empty(), "bundle must not be empty");
    assert!(body.contains("=== daak debug bundle ==="));
    assert!(body.contains("=== version ==="));
    assert!(body.contains("=== identity ==="));
    assert!(body.contains("=== recent log ==="));
    assert!(body.contains("daakd started"));
}

/// The bundle names this device, its listen address and its log, so it must
/// not be world-readable under a loose umask.
#[cfg(unix)]
#[test]
fn the_bundle_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("debug-bundle.txt");
    daakd::debug_bundle::export(&path, &daakd::debug_bundle::DebugState::default()).unwrap();
    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "bundle must be 0600, got {mode:o}");
}

/// A diagnostics request must not become an arbitrary-file-overwrite
/// primitive: only a single component under the daemon's own directory.
#[test]
fn the_wire_path_must_be_a_single_file_name() {
    for bad in [
        "",
        ".",
        "..",
        "../escape.txt",
        "a/b.txt",
        "/etc/passwd",
        "..\\escape.txt",
    ] {
        let r = daakd::debug_bundle::sanitize_bundle_name(bad);
        assert!(r.is_err(), "{bad:?} must be refused, got {r:?}");
    }
    assert_eq!(
        daakd::debug_bundle::sanitize_bundle_name("bundle.txt").unwrap(),
        "bundle.txt"
    );
}

/// A Windows drive-relative name has no separator and is not absolute, so only
/// the component check catches it -- and `PathBuf::push` with a prefix
/// REPLACES the whole path, which is how it would escape the export dir. On
/// Unix the same string is a legal file name, so this is a per-platform claim.
#[cfg(windows)]
#[test]
fn a_drive_relative_name_is_refused() {
    for bad in ["C:escape.txt", "C:"] {
        assert!(
            daakd::debug_bundle::sanitize_bundle_name(bad).is_err(),
            "{bad:?} must be refused on Windows"
        );
    }
}
