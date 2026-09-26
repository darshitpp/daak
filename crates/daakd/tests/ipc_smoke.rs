#![cfg(unix)]

use daak_ipc::{
    read_message, write_message, IpcEvent, IpcMessage, IpcRequest, IpcResponse, IPC_MAGIC,
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

    write_message(&mut stream, &IpcMessage::Request(IpcRequest::Devices))
        .await
        .unwrap();
    assert!(matches!(
        read_message(&mut stream).await.unwrap().unwrap(),
        IpcMessage::Response(IpcResponse::Json { .. })
    ));

    // Everything the engine does not serve yet answers; it does not hang.
    write_message(&mut stream, &IpcMessage::Request(IpcRequest::ListInbox))
        .await
        .unwrap();
    assert!(matches!(
        read_message(&mut stream).await.unwrap().unwrap(),
        IpcMessage::Response(IpcResponse::Error { .. })
    ));

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
    write_message(&mut live, &IpcMessage::Request(IpcRequest::Devices))
        .await
        .unwrap();
    assert!(matches!(
        read_message(&mut live).await.unwrap().unwrap(),
        IpcMessage::Response(IpcResponse::Json { .. })
    ));

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
    write_message(&mut frame, &IpcMessage::Request(IpcRequest::Devices))
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
            Some(IpcMessage::Response(IpcResponse::Json { .. })) => {
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
