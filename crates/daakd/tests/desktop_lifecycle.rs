#![cfg(unix)]

//! Phase 6 exit criterion: "the daemon outlives client disconnects."
//!
//! A closed dashboard window is a dropped IPC client. If the daemon died with
//! it, tray send while the window is closed could not work -- which is the
//! criterion in one sentence.
//!
//! SOCKET-DEPENDENT: binds a real Unix socket, so the controller runs this
//! escalated. See the task report.

use daak_ipc::{read_message, write_message, IpcEvent, IpcMessage, IpcRequest, IpcResponse};
use std::time::Duration;
use tokio::sync::broadcast;

/// Connect once the listener is up. A fixed sleep would flake on a loaded box.
/// Same helper, same reason, as tests/ipc_smoke.rs.
async fn connect(sock: &std::path::Path) -> tokio::net::UnixStream {
    for _ in 0..200 {
        if let Ok(s) = tokio::net::UnixStream::connect(sock).await {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("daakd never bound {}", sock.display());
}

#[tokio::test]
async fn daemon_survives_client_disconnects() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("daakd.sock");

    // serve_with, NOT serve. serve() calls debug_bundle::init_tracing(), a
    // process-wide try_init, and one test binary starts MANY daakd -- the
    // second try_init fails. Same reason ipc_smoke.rs injects its events.
    let (events, _rx) = broadcast::channel::<IpcEvent>(16);
    let handle = tokio::spawn({
        let sock = sock.clone();
        async move { daakd::serve_with(&sock, events).await.unwrap() }
    });

    // First client subscribes, reads its reply, then vanishes: the dashboard
    // window closing. The reply is read BEFORE the drop, so a daemon that
    // answered nothing fails here instead of at the second client.
    {
        let mut first = connect(&sock).await;
        write_message(&mut first, &IpcMessage::Request(IpcRequest::Subscribe))
            .await
            .unwrap();
        assert!(matches!(
            read_message(&mut first).await.unwrap().unwrap(),
            IpcMessage::Response(IpcResponse::Ok)
        ));
    }

    // A second, brand new connection still gets a real reply: the daemon
    // outlived the first client.
    //
    // The reply is an Error, not the plan's `Json { .. }`. Devices routes
    // through state.engine() (lib.rs:454), which is None until Start, and
    // answers NOT_STARTED. Asserting Json would need a live engine, and that
    // means a real data_dir plus a TCP listener and mDNS registration --
    // which is exactly what tests/engine_dispatch.rs is for, on purpose. This
    // test's claim is the daemon's SURVIVAL, and a daemon that died cannot
    // answer either variant.
    let mut second = connect(&sock).await;
    write_message(&mut second, &IpcMessage::Request(IpcRequest::Devices))
        .await
        .unwrap();
    match read_message(&mut second).await.unwrap().unwrap() {
        IpcMessage::Response(IpcResponse::Error { message }) => {
            assert!(message.contains("Start"), "{message}")
        }
        other => panic!("expected the NOT_STARTED Error, got {other:?}"),
    }

    handle.abort();
}
