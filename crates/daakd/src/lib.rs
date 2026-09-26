//! The desktop daemon's IPC server. Skeleton: it binds the socket, serves the
//! Subscribe/Devices handshake and fans engine events out to subscribers.
//!
//! ponytail: no engine lives here yet, so every other request answers
//! "unimplemented" and the broadcast channel has no producer. Task 9 wires the
//! real daak_core::engine::Engine in; upgrade this to a dispatch table then,
//! not before.

use std::path::Path;
use std::sync::Arc;

use daak_ipc::{read_message, write_message, IpcEvent, IpcMessage, IpcRequest, IpcResponse};
use tokio::sync::broadcast;

const EVENT_BUFFER: usize = 1024;

/// Bind daak_ipc::socket_path() and serve forever.
pub async fn serve(path: &Path) -> std::io::Result<()> {
    // The receiver is dropped on purpose; each subscriber gets its own.
    let (events, _rx) = broadcast::channel::<IpcEvent>(EVENT_BUFFER);
    serve_with(path, events).await
}

/// Same as serve, but the event source is injected. Task 9 bridges the
/// engine's event stream into this sender; the test needs it to publish.
pub async fn serve_with(path: &Path, events: broadcast::Sender<IpcEvent>) -> std::io::Result<()> {
    let listener = bind(path)?;
    let events = Arc::new(events);

    loop {
        let (stream, _) = listener.accept().await?;
        let events = events.clone();
        tokio::spawn(async move {
            // The read and write halves are separate owners, so select! can
            // borrow one in each arm; a single &mut stream would not
            // borrow-check.
            let (mut rd, mut wr) = stream.into_split();
            let mut rx = events.subscribe();
            let mut subscribed = false;
            loop {
                tokio::select! {
                    msg = read_message(&mut rd) => {
                        // A clean disconnect (Ok(None)) and a truncated body
                        // (Err) both end this connection.
                        let Some(IpcMessage::Request(req)) = msg.ok().flatten() else {
                            break;
                        };
                        let reply = match req {
                            IpcRequest::Subscribe => {
                                subscribed = true;
                                IpcMessage::Response(IpcResponse::Ok)
                            }
                            IpcRequest::Devices => {
                                IpcMessage::Response(IpcResponse::Json { value: "[]".into() })
                            }
                            IpcRequest::Shutdown => break,
                            _ => IpcMessage::Response(IpcResponse::Error {
                                message: "unimplemented".into(),
                            }),
                        };
                        if write_message(&mut wr, &reply).await.is_err() {
                            break;
                        }
                    }
                    ev = rx.recv(), if subscribed => {
                        // ponytail: a lagged subscriber keeps its connection
                        // and silently misses events; Task 9 can drop the
                        // client or send an Error when that matters.
                        if let Ok(ev) = ev {
                            if write_message(&mut wr, &IpcMessage::Event(ev)).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            }
        });
    }
}

/// Create the socket's parent directory, prove it is ours, and bind 0600.
#[cfg(unix)]
fn bind(path: &Path) -> std::io::Result<tokio::net::UnixListener> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        // socket_path() falls back to /tmp when XDG_RUNTIME_DIR is unset, so
        // another user could pre-create that parent and a socket inside it.
        // Refuse rather than chmod a directory we do not own.
        // SAFETY: geteuid takes no arguments and cannot fail.
        check_owned_by_us(parent, unsafe { libc::geteuid() })?;
        // A stale socket from a crashed daemon is ours to remove; anything
        // else is not a socket and bind() refuses it below.
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    let listener = tokio::net::UnixListener::bind(path)?;
    set_mode(path, 0o600)?;
    Ok(listener)
}

/// The `me` parameter exists so this branch is testable without a second uid;
/// production always passes geteuid().
#[cfg(unix)]
fn check_owned_by_us(dir: &Path, me: u32) -> std::io::Result<()> {
    use std::os::unix::fs::MetadataExt;

    let md = std::fs::metadata(dir)?;
    if !md.is_dir() {
        let msg = format!("{} is not a directory", dir.display());
        return Err(std::io::Error::new(std::io::ErrorKind::NotADirectory, msg));
    }
    if md.uid() != me {
        let msg = format!("{} is owned by uid {}, not {me}", dir.display(), md.uid());
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            msg,
        ));
    }
    set_mode(dir, 0o700)
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

// ponytail: Windows needs a named-pipe server on \\.pipe\daakd with a
// current-user ACL, not a Unix socket, so the daemon refuses to start there
// rather than pretending to serve. Task 10's packaging spike owns it.
#[cfg(windows)]
pub async fn serve(path: &Path) -> std::io::Result<()> {
    let (events, _rx) = broadcast::channel::<IpcEvent>(EVENT_BUFFER);
    serve_with(path, events).await
}

#[cfg(windows)]
pub async fn serve_with(_path: &Path, _events: broadcast::Sender<IpcEvent>) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "named-pipe server not implemented; see Task 10",
    ))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn a_parent_owned_by_another_uid_is_refused_and_not_repaired() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("daak");
        std::fs::create_dir(&sub).unwrap();
        set_mode(&sub, 0o777).unwrap();

        let err = check_owned_by_us(&sub, 1).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
        // Refused means untouched: no quiet chmod of a directory we don't own.
        assert_eq!(
            std::fs::metadata(&sub).unwrap().permissions().mode() & 0o777,
            0o777
        );
    }
}
