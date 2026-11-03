use daak_core::diag::{self, DebugState};

#[test]
fn bundle_says_not_installed_when_a_subscriber_exists() {
    let host = tracing_subscriber::fmt().finish();
    tracing::subscriber::set_global_default(host).unwrap();
    assert!(!diag::init(None));
    assert!(!diag::capture_installed());
    let body = diag::render_capped(
        "daak",
        &DebugState {
            events: vec!["stale line\n".into()],
            ..DebugState::default()
        },
    );
    assert!(body.contains("log capture: not installed"));
    assert!(!body.contains("stale line"));
}
