#![cfg(unix)]

use daak_ipc::{
    read_message, write_message, IpcEvent, IpcMessage, IpcRequest, IpcResponse, IPC_MAGIC,
    IPC_MAX_FRAME,
};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::sync::broadcast;

/// Connect once the listener is up. A fixed sleep would flake on a loaded box.
async fn connect(sock: &std::path::Path) -> tokio::net::UnixStream {
    for _ in 0..200 {
        if let Ok(s) = tokio::net::UnixStream::connect(sock).await {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("daakd never bound {}", sock.display());
}

/// Poll the daemon's ring until every one of `needles` has shown up, then
/// hand back the whole ring. The ring is a `Vec<String>` snapshot, so
/// `lines` in the panic message below is the real state at the last poll.
/// A daemon that never logs what it was asked to log fails on the deadline
/// rather than hanging the suite.
async fn wait_for_log(needles: &[&str]) -> Vec<String> {
    for _ in 0..200 {
        let lines = daakd::debug_bundle::recent_log().snapshot();
        let joined = lines.join("\n");
        if needles.iter().all(|n| joined.contains(n)) {
            return lines;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let lines = daakd::debug_bundle::recent_log().snapshot();
    panic!("the ring never showed all of {needles:?}; last state: {lines:?}");
}

#[tokio::test]
async fn daemon_serves_a_subscribe_and_devices_request() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("daakd.sock");
    let (events, _rx) = broadcast::channel::<IpcEvent>(16);
    let handle = tokio::spawn({
        let sock = sock.clone();
        async move { daakd::serve_with(&sock, events).await.unwrap() }
    });

    let mut stream = connect(&sock).await;
    write_message(&mut stream, &IpcMessage::Request(IpcRequest::Subscribe))
        .await
        .unwrap();
    assert!(matches!(
        read_message(&mut stream).await.unwrap().unwrap(),
        IpcMessage::Response(IpcResponse::Ok)
    ));

    // No engine yet: Devices says so instead of inventing an empty list, and
    // every other engine-backed request answers rather than hanging. The
    // engine-backed happy paths live in tests/engine_dispatch.rs.
    for req in [IpcRequest::Devices, IpcRequest::ListInbox] {
        write_message(&mut stream, &IpcMessage::Request(req))
            .await
            .unwrap();
        match read_message(&mut stream).await.unwrap().unwrap() {
            IpcMessage::Response(IpcResponse::Error { message }) => {
                assert!(message.contains("Start"), "{message}")
            }
            other => panic!("expected an Error, got {other:?}"),
        }
    }

    handle.abort();
}

#[tokio::test]
async fn an_event_reaches_every_subscribed_client() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("daakd.sock");
    let (events, _rx) = broadcast::channel::<IpcEvent>(16);
    let publisher = events.clone();
    let handle = tokio::spawn({
        let sock = sock.clone();
        async move { daakd::serve_with(&sock, events).await.unwrap() }
    });

    let mut a = connect(&sock).await;
    let mut b = connect(&sock).await;
    for s in [&mut a, &mut b] {
        write_message(s, &IpcMessage::Request(IpcRequest::Subscribe))
            .await
            .unwrap();
        assert!(matches!(
            read_message(s).await.unwrap().unwrap(),
            IpcMessage::Response(IpcResponse::Ok)
        ));
    }

    publisher
        .send(IpcEvent::TransferDone {
            transfer_id: "t1".into(),
        })
        .unwrap();
    for s in [&mut a, &mut b] {
        assert_eq!(
            read_message(s).await.unwrap().unwrap(),
            IpcMessage::Event(IpcEvent::TransferDone {
                transfer_id: "t1".into()
            })
        );
    }

    handle.abort();
}

#[tokio::test]
async fn a_dropped_or_truncated_client_does_not_kill_the_daemon() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("daakd.sock");
    let (events, _rx) = broadcast::channel::<IpcEvent>(16);
    let handle = tokio::spawn({
        let sock = sock.clone();
        async move { daakd::serve_with(&sock, events).await.unwrap() }
    });

    // Clean disconnect: magic-less EOF, i.e. read_message -> Ok(None).
    drop(connect(&sock).await);
    // Truncated body: magic plus a length prefix with no body, i.e. Err.
    {
        let mut s = connect(&sock).await;
        s.write_all(&daak_ipc::IPC_MAGIC).await.unwrap();
        s.write_all(&8u32.to_be_bytes()).await.unwrap();
        s.flush().await.unwrap();
    }

    let mut live = connect(&sock).await;
    write_message(&mut live, &IpcMessage::Request(IpcRequest::Subscribe))
        .await
        .unwrap();
    assert!(matches!(
        read_message(&mut live).await.unwrap().unwrap(),
        IpcMessage::Response(IpcResponse::Ok)
    ));

    handle.abort();
}

/// B6: the per-connection lifecycle the bundle needs. `a_dropped_or_truncated
/// _client_does_not_kill_the_daemon` already drives both of these paths but
/// asserted only the survivor, so the daemon could drop a connection for any
/// reason and the ring would stay empty. The ring is the thing the user reads
/// in a bug report, so assert the FORMATTED lines it will actually contain.
///
/// SCOPE, and it is narrower than it looks. The reply-write and event-write
/// failures are NOT asserted here and cannot be: on an ACCEPTED socket the
/// reply to any request a client can send before `Start` is ~50 bytes, and the
/// kernel buffer accepts that with no reader at all, so the daemon lands on
/// its READ arm instead. Those two paths are covered socket-free in the lib
/// tests over an in-memory duplex; duplicating a 1 MiB reply here only
/// reproduced the CLIENT's own BrokenPipe, twice. What this adds is the
/// accept path end to end.
///
/// B6 review M-1, and this is the part that matters: the ring is
/// PROCESS-GLOBAL, and `a_dropped_or_truncated_client_does_not_kill_the_daemon`
/// above already drives an identical truncated frame and an identical clean
/// disconnect. The first cut of this test asserted only "unreadable frame" and
/// "ipc client disconnected", so it passed on the sibling's leftovers alone --
/// it was not testing this daemon's connections at all. Every needle below is
/// therefore something THIS test uniquely produces:
///
///   * the oversize frame names an exact byte count no other test sends, so
///     the assertion cannot be met by another test's lines;
///   * the disconnect is proven by the client observing EOF on a socket it
///     still holds, which is this connection's own teardown.
///
/// The length prefix is `IPC_MAX_FRAME + 1` and not something merely large:
/// read_message rejects an oversize prefix BEFORE allocating or reading a body,
/// so the unique text costs nothing. A prefix under the cap (the review
/// suggested 0x11_11_11) would make the daemon allocate and read ~1 MB first.
/// AWAIT RULE, and this test used to hang the suite over it: `read_message`
/// maps only `UnexpectedEof` to `Ok(None)`, so a client that writes a PARTIAL
/// magic and keeps the socket open parks forever waiting for the rest of it,
/// and there is no read deadline to save it. Every connection below is
/// write-then-drop, and the only client-side `read_message` is the
/// `ListInbox` reply, which the daemon is guaranteed to answer. Do not add an
/// await to any other block here.
///
/// SOCKET-GATED: needs a real Unix socket. Run escalated.
#[tokio::test]
async fn a_bad_or_lost_connection_leaves_a_line_in_the_debug_bundle() {
    // The daemon process installs this; serve_with deliberately does not, so
    // the many daakd one test binary starts do not race for the global
    // try_init. Ignore a losing race with another installer.
    let _ = daakd::debug_bundle::init_tracing();

    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("daakd.sock");
    let (events, _rx) = broadcast::channel::<IpcEvent>(16);
    let handle = tokio::spawn({
        let sock = sock.clone();
        async move { daakd::serve_with(&sock, events).await.unwrap() }
    });

    // An OVERSIZE frame: the full magic, then a length prefix one byte past
    // the cap and no payload at all. The read future returns Err naming that
    // exact count, which used to `break` with nothing written anywhere. The
    // magic has to be COMPLETE: a short magic is a dropped connection
    // (read_message answers Ok(None) for it), not a bad frame.
    //
    // This is deliberately NOT the sibling test's `8u32` truncated frame --
    // that one is in the same process-global ring and would satisfy an
    // "unreadable frame" assertion on its own.
    {
        let mut s = connect(&sock).await;
        s.write_all(&IPC_MAGIC).await.unwrap();
        s.write_all(&(IPC_MAX_FRAME + 1).to_be_bytes())
            .await
            .unwrap();
        s.flush().await.unwrap();
    }
    // A clean disconnect: connect, send NOTHING, drop. A real EOF with no
    // partial frame is the only shape that reads as Ok(None) at the daemon.
    //
    // The client must NOT await anything here. It also must not write a
    // PARTIAL magic: read_message maps only UnexpectedEof to Ok(None), so two
    // magic bytes on an OPEN socket is a partial read that parks forever
    // waiting for the other two -- which hung this whole suite once. The
    // disconnect is asserted through the ring line, not on this side.
    {
        let s = connect(&sock).await;
        drop(s);
    }
    // An engine-backed request, so the err() line is proven on a live
    // connection too rather than only through the pure err() unit test.
    {
        let mut s = connect(&sock).await;
        write_message(&mut s, &IpcMessage::Request(IpcRequest::ListInbox))
            .await
            .unwrap();
        assert!(matches!(
            read_message(&mut s).await.unwrap().unwrap(),
            IpcMessage::Response(IpcResponse::Error { .. })
        ));
    }

    // The handler logs on its own task, so a dropped client does NOT mean a
    // logged line yet. Poll rather than snapshot once: a fixed sleep either
    // flakes on a loaded box or wastes time on a fast one.
    //
    // The first needle is the load-bearing one: it names IPC_MAX_FRAME + 1 and
    // no other test in this binary sends that.
    let unique = format!("frame of {} bytes exceeds", IPC_MAX_FRAME + 1);
    let lines = wait_for_log(&[&unique, "ipc client disconnected", "ipc error:"]).await;
    let joined = lines.join("\n");
    assert!(
        joined.contains(&unique),
        "this test's own oversize frame left no uniquely-identifiable line: {lines:?}"
    );
    assert!(
        joined.contains("ipc client disconnected") && joined.contains("ipc error:"),
        "no disconnect or err() line in the ring: {lines:?}"
    );
    handle.abort();
}

#[tokio::test]
async fn the_socket_and_its_parent_are_locked_to_the_owner() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    // A pre-existing, world-writable parent is what a hostile /tmp looks like.
    std::fs::create_dir(dir.path().join("daak")).unwrap();
    std::fs::set_permissions(
        dir.path().join("daak"),
        std::fs::Permissions::from_mode(0o777),
    )
    .unwrap();
    let sock = dir.path().join("daak").join("daakd.sock");

    let (events, _rx) = broadcast::channel::<IpcEvent>(16);
    let handle = tokio::spawn({
        let sock = sock.clone();
        async move { daakd::serve_with(&sock, events).await.unwrap() }
    });
    let _ = connect(&sock).await;

    let parent_mode = std::fs::metadata(sock.parent().unwrap())
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(parent_mode, 0o700, "parent dir must be 0700");
    assert_eq!(
        std::fs::metadata(&sock).unwrap().permissions().mode() & 0o777,
        0o600,
        "socket must be 0600"
    );

    handle.abort();
}

#[tokio::test]
async fn an_unusable_parent_is_a_hard_error_not_a_swallowed_one() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("not-a-dir");
    std::fs::write(&file, b"").unwrap();
    let sock = file.join("daakd.sock");
    let (events, _rx) = broadcast::channel::<IpcEvent>(16);
    let err = daakd::serve_with(&sock, events).await.unwrap_err();
    // create_dir_all reports AlreadyExists and check_owned_by_us would report
    // NotADirectory; either is fine. What matters is that it is reported at
    // all and no socket is left behind, which is what the plan swallowed.
    assert!(
        matches!(
            err.kind(),
            std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::NotADirectory
        ),
        "unexpected error: {err:?}"
    );
    assert!(!sock.exists());
}

/// C1: read_message reads into fresh buffers, so a select! that drops it
/// mid-frame eats the prefix. Split the frame and fire an event in the gap.
#[tokio::test]
async fn a_frame_split_across_two_writes_survives_an_event_in_the_gap() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("daakd.sock");
    let (events, _rx) = broadcast::channel::<IpcEvent>(16);
    let publisher = events.clone();
    let handle = tokio::spawn({
        let sock = sock.clone();
        async move { daakd::serve_with(&sock, events).await.unwrap() }
    });

    let mut stream = connect(&sock).await;
    write_message(&mut stream, &IpcMessage::Request(IpcRequest::Subscribe))
        .await
        .unwrap();
    assert!(matches!(
        read_message(&mut stream).await.unwrap().unwrap(),
        IpcMessage::Response(IpcResponse::Ok)
    ));

    // Serialise the next request by hand so it can be written in two halves.
    let mut frame = Vec::new();
    write_message(&mut frame, &IpcMessage::Request(IpcRequest::ListInbox))
        .await
        .unwrap();
    assert_eq!(&frame[..4], &IPC_MAGIC);
    let (head, tail) = frame.split_at(4);

    stream.write_all(head).await.unwrap();
    stream.flush().await.unwrap();
    // Let the daemon swallow the magic and park inside the length-prefix read.
    tokio::time::sleep(Duration::from_millis(150)).await;
    publisher
        .send(IpcEvent::TransferDone {
            transfer_id: "t1".into(),
        })
        .unwrap();
    stream.write_all(tail).await.unwrap();
    stream.flush().await.unwrap();

    // The event arrives (the event arm won the select!), then the request that
    // was already half-read must still be answered.
    let mut saw_event = false;
    for _ in 0..4 {
        match read_message(&mut stream).await.unwrap() {
            Some(IpcMessage::Event(_)) => saw_event = true,
            Some(IpcMessage::Response(IpcResponse::Error { .. })) => {
                assert!(saw_event, "expected the event before the response");
                handle.abort();
                return;
            }
            other => panic!("unexpected message: {other:?}"),
        }
    }
    handle.abort();
    panic!("the split request was never answered; the connection was torn down");
}

/// M1: bind() must not unlink a regular file that happens to sit at the socket
/// path -- that silently deletes user data.
#[tokio::test]
async fn a_regular_file_at_the_socket_path_is_kept_and_refused() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("daakd.sock");
    std::fs::write(&sock, b"precious").unwrap();
    let (events, _rx) = broadcast::channel::<IpcEvent>(16);

    // Bounded: on today's code bind() unlinks the file and then serves
    // forever, so the failure mode is a hang, not an error.
    let err = tokio::time::timeout(Duration::from_secs(5), daakd::serve_with(&sock, events))
        .await
        .expect("serve_with must refuse, not serve over a regular file")
        .unwrap_err();
    assert!(!err.to_string().is_empty(), "error must say why");
    assert_eq!(std::fs::read(&sock).unwrap(), b"precious");
}
