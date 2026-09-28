//! The user-visible debug bundle: a plain-text dump of the daemon's version,
//! identity and recent log, written on request over IPC so a user can attach
//! it to a bug report without opening a terminal.

use std::collections::VecDeque;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::sync::{Mutex, OnceLock};
use tracing_subscriber::fmt::MakeWriter;

/// How many events the ring keeps. Enough to cover a failing startup or a
/// transfer attempt; not so much that a runaway peer can grow the heap.
pub const RING_CAPACITY: usize = 512;

#[derive(Debug, Clone, Default)]
pub struct DebugState {
    pub version: String,
    pub device_id: String,
    pub listen_addr: String,
    pub events: Vec<String>,
}

pub fn export(path: &Path, state: &DebugState) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut f = std::fs::File::create(path)?;
    // The bundle names this device, its listen address and its log, so it is
    // 0600 regardless of umask. Windows has no Unix mode and the file is
    // already under the user profile the daemon owns.
    set_private(path)?;
    writeln!(f, "=== daak debug bundle ===")?;
    writeln!(f, "generated_at_ms: {}", daak_core::manifest::now_ms())?;
    writeln!(f, "=== version ===")?;
    writeln!(f, "daakd {}", state.version)?;
    writeln!(f, "=== identity ===")?;
    writeln!(f, "device_id: {}", state.device_id)?;
    writeln!(f, "listen_addr: {}", state.listen_addr)?;
    writeln!(f, "=== recent log ===")?;
    for line in &state.events {
        writeln!(f, "{line}")?;
    }
    f.flush()
}

#[cfg(unix)]
fn set_private(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_private(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// The last `RING_CAPACITY` formatted log lines.
///
/// It is a `MakeWriter` rather than a `Layer` because capturing the FORMATTED
/// line is what the bundle needs, and the fmt layer already knows how to format
/// one. A `Layer` would have to rebuild that same string by hand: either walk
/// the event's fields through a typed visitor, or name `tracing_core::Event`
/// and pick its fields apart, and either way the formatting lives in daakd
/// instead of in the fmt layer that already gets it right. ponytail: this is
/// the whole subscriber -- there is no level filter and no file sink; add those
/// when a bug report needs more than the last 512 lines.
#[derive(Clone, Default)]
pub struct RecentLog {
    lines: Arc<Mutex<VecDeque<String>>>,
}

impl RecentLog {
    pub fn snapshot(&self) -> Vec<String> {
        match self.lines.lock() {
            Ok(q) => q.iter().cloned().collect(),
            // A panic while a line was being formatted poisoned the lock. The
            // bundle is a diagnostic; returning whatever survived beats
            // failing the request the user sent to debug the failure.
            Err(_) => Vec::new(),
        }
    }
}

/// Accumulates one event's `write` calls, then commits it as a single line on
/// drop. The fmt layer makes a writer per event and drops it when it is done.
pub struct LineWriter<'a> {
    // Bytes, not String: the fmt layer may write one event in several chunks
    // that split a multi-byte char, and from_utf8_lossy per chunk would turn
    // that into replacement characters in the bundle.
    buf: Vec<u8>,
    lines: &'a Mutex<VecDeque<String>>,
}

impl Write for LineWriter<'_> {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.buf.extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Drop for LineWriter<'_> {
    fn drop(&mut self) {
        if self.buf.is_empty() {
            return;
        }
        let line = String::from_utf8_lossy(&self.buf).into_owned();
        if let Ok(mut q) = self.lines.lock() {
            while q.len() >= RING_CAPACITY {
                q.pop_front();
            }
            q.push_back(line);
        }
    }
}

impl<'a> MakeWriter<'a> for RecentLog {
    type Writer = LineWriter<'a>;
    fn make_writer(&'a self) -> Self::Writer {
        LineWriter {
            buf: Vec::new(),
            lines: &self.lines,
        }
    }
}

static RECENT_LOG: OnceLock<RecentLog> = OnceLock::new();

/// The daemon's one ring buffer, created on first use so a process that never
/// logs a line (or a test) pays nothing for it.
pub fn recent_log() -> &'static RecentLog {
    RECENT_LOG.get_or_init(RecentLog::default)
}

/// Make the ring buffer the daemon's global subscriber. The error is NOT
/// swallowed: a losing `try_init` means the ring will never see a line, and an
/// `Ok` bundle with an empty `recent log` would be a lie about what was
/// captured.
pub fn init_tracing() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer()
                // Plain text: the bundle is read in a bug-report editor.
                .with_ansi(false)
                .with_writer(recent_log().clone()),
        )
        .try_init()?;
    Ok(())
}

/// The only shape the wire path may take: ONE path component, so the join
/// above can never escape the daemon's own `debug-bundles/` directory.
/// Absolute paths, separators, `.`/`..` and embedded NULs are refused rather
/// than sanitised, because a client that sends one has a bug and silently
/// writing somewhere else hides it.
pub fn sanitize_bundle_name(path: &str) -> Result<String, String> {
    if path.is_empty() {
        return Err("debug bundle name must not be empty".into());
    }
    if path == "." || path == ".." {
        return Err(format!("debug bundle name {path:?} is not a file name"));
    }
    if path.contains('/') || path.contains('\\') || path.contains('\0') {
        return Err(format!(
            "debug bundle name must be a single file name, got {path:?}"
        ));
    }
    if Path::new(path).is_absolute() {
        return Err(format!("debug bundle name must be relative, got {path:?}"));
    }
    // Exactly one NORMAL component. The string checks above already cover
    // Unix, but a Windows `C:foo` is drive-RELATIVE (is_absolute() is false)
    // and `PathBuf::push` with a prefix REPLACES the whole path, so a Windows
    // caller would escape the directory. `components()` is the platform's own
    // answer; the Normal filter is what makes the count portable, because on
    // Unix a `C:` prefix is a legal (if odd) single file name.
    if Path::new(path)
        .components()
        .filter(|c| matches!(c, std::path::Component::Normal(_)))
        .count()
        != 1
    {
        return Err(format!(
            "debug bundle name must be a single file name, got {path:?}"
        ));
    }
    Ok(path.to_string())
}

/// A `DebugState` snapshot of the live daemon: its own version, its identity
/// when an engine exists, and the ring buffer.
pub fn snapshot_state(device_id: String, listen_addr: String) -> DebugState {
    DebugState {
        version: env!("CARGO_PKG_VERSION").to_string(),
        device_id,
        listen_addr,
        events: recent_log().snapshot(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ring_keeps_the_last_512_lines() {
        let ring = RecentLog::default();
        for i in 0..RING_CAPACITY + 10 {
            let mut w = ring.make_writer();
            writeln!(w, "line {i}").unwrap();
            w.flush().unwrap();
        }
        let lines = ring.snapshot();
        assert_eq!(lines.len(), RING_CAPACITY);
        // The oldest went first, so the newest is the last line and the count
        // is the cap rather than everything ever logged.
        assert_eq!(lines.last().unwrap(), "line 521\n");
        assert_eq!(lines.first().unwrap(), "line 10\n");
    }
}
