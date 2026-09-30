use daak_ipc::socket_path;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    // `--passphrase-stdin` reads ONE line from stdin and wraps the OS
    // keystore in Argon2id + ChaCha20-Poly1305.
    //
    // NOT REACHABLE TODAY: no unit file, installer or UI passes this flag, and
    // a launchd/systemd service has no stdin to read it from. It is implemented
    // and tested only at the crypto layer (crates/daak-core/tests/secret_store_os.rs);
    // as a PRODUCT feature the passphrase gate does not exist yet, because
    // nothing collects a passphrase from a user. Do not describe it as working
    // until something can. The upgrade path is a credential the installer or
    // the desktop app hands the daemon, not a flag a service can read.
    //
    // Nothing else parses argv: an unknown flag is ignored rather than fatal,
    // matching the daemon's no-port-argument contract in daemons/ and
    // scripts/desktop-smoke.sh.
    let passphrase = if std::env::args().any(|a| a == "--passphrase-stdin") {
        let mut buf = String::new();
        std::io::stdin().read_line(&mut buf)?;
        Some(buf.trim_end_matches(['\n', '\r']).to_string())
    } else {
        None
    };

    // DEBUG BUILDS ONLY. Tests and smokes must never touch -- or prompt for --
    // the login Keychain: a rebuilt/unsigned daakd does not inherit trust from
    // the ACL of items an older build created, so SecItemCopyMatching blocks on
    // a password dialog that no CI or smoke can answer, and the 5s/10s test
    // timeouts fire instead. serve() already uses the 0600 file store, so this
    // is the same identity path minus the popup.
    //
    // cfg(debug_assertions), not cfg!(debug_assertions): a RELEASE build must
    // not honour the variable at all, so the keystore call is not merely
    // ignored there, it is not compiled in. Production behaviour is unchanged.
    #[cfg(debug_assertions)]
    if std::env::var("DAAK_TEST_FILE_STORE").is_ok_and(|v| !v.is_empty()) {
        return daakd::serve(&socket_path()).await;
    }

    let store = daak_core::crypto::platform_secret_store(passphrase.as_deref())
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    daakd::serve_with_store(&socket_path(), store).await
}
