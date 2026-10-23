//! Shared diagnostics: a ring buffer of recent log lines, the debug bundle
//! renderer, and the subscriber install for apps that run the engine in
//! process. The ring buffer is the only log store. It never writes to disk.

use std::collections::VecDeque;
use std::io::Write;
use std::sync::{Arc, Mutex, OnceLock};
use tracing::Level;
use tracing_subscriber::filter::{LevelFilter, Targets};
use tracing_subscriber::fmt::format::FmtSpan;
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::{registry, Layer, Registry};

/// Lines kept by the default ring. This is the `daakd` value.
pub const RING_CAPACITY: usize = 512;
/// Lines kept by the apps ring.
const APP_RING_CAPACITY: usize = 2000;
/// Longest line, in bytes, that the apps ring keeps.
const APP_MAX_LINE: usize = 512;
/// Largest bundle that `render_capped` returns, in bytes.
pub const BUNDLE_MAX_BYTES: usize = 256 * 1024;

const NOT_INSTALLED: &str = "log capture: not installed";

#[derive(Debug, Clone, Default)]
pub struct DebugState {
    pub version: String,
    pub device_id: String,
    pub listen_addr: String,
    pub events: Vec<String>,
}

/// Write the bundle text. The layout is the same as the `daakd` bundle.
/// The version line reads `"{product} {version}"`.
pub fn render(product: &str, state: &DebugState) -> String {
    let mut s = String::new();
    s.push_str("=== daak debug bundle ===\n");
    s.push_str(&format!("generated_at_ms: {}\n", crate::manifest::now_ms()));
    s.push_str("=== version ===\n");
    s.push_str(&format!("{product} {}\n", state.version));
    s.push_str("=== identity ===\n");
    s.push_str(&format!("device_id: {}\n", state.device_id));
    s.push_str(&format!("listen_addr: {}\n", state.listen_addr));
    s.push_str("=== recent log ===\n");
    for line in &state.events {
        s.push_str(line);
        s.push('\n');
    }
    s
}

/// Like `render`, but the result is at most `BUNDLE_MAX_BYTES` long.
/// It drops the oldest lines first. It prints `log capture: not installed`
/// in place of the log when a host owns the global subscriber.
pub fn render_capped(product: &str, state: &DebugState) -> String {
    let mut st = state.clone();
    if !capture_installed() {
        st.events = vec![NOT_INSTALLED.to_string()];
    }
    let mut lines = std::mem::take(&mut st.events);
    // Size of the bundle without any log line.
    let base = render(product, &st).len();
    let mut total: usize = lines.iter().map(|l| l.len() + 1).sum();
    let mut drop_count = 0;
    while base + total > BUNDLE_MAX_BYTES && drop_count < lines.len() {
        total -= lines[drop_count].len() + 1;
        drop_count += 1;
    }
    st.events = lines.split_off(drop_count);
    render(product, &st)
}

/// The last lines of formatted log output.
///
/// It is a `MakeWriter` and not a `Layer`. The fmt layer already formats an
/// event, so the ring only stores the finished line.
#[derive(Clone)]
pub struct RecentLog {
    lines: Arc<Mutex<VecDeque<String>>>,
    cap: usize,
    max_line: Option<usize>,
}

impl Default for RecentLog {
    fn default() -> Self {
        Self::with_capacity(RING_CAPACITY, None)
    }
}

impl RecentLog {
    /// `cap` is the number of lines kept. `max_line` is the longest line in
    /// bytes, not counting the final newline. A longer line is cut on a UTF-8
    /// boundary and keeps its newline.
    pub fn with_capacity(cap: usize, max_line: Option<usize>) -> Self {
        Self {
            lines: Arc::new(Mutex::new(VecDeque::new())),
            cap,
            max_line,
        }
    }

    pub fn snapshot(&self) -> Vec<String> {
        match self.lines.lock() {
            Ok(q) => q.iter().cloned().collect(),
            // A panic while a line was written poisoned the lock. The bundle
            // is a diagnostic, so it returns what it has and does not fail.
            Err(_) => Vec::new(),
        }
    }
}

/// Collects the `write` calls of one event. It commits one line on drop.
pub struct LineWriter<'a> {
    // Bytes, not String. The fmt layer can split a multi-byte char across
    // two writes.
    buf: Vec<u8>,
    log: &'a RecentLog,
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
        let mut line = String::from_utf8_lossy(&self.buf).into_owned();
        if let Some(max) = self.log.max_line {
            let had_newline = line.ends_with('\n');
            let body_len = line.len() - usize::from(had_newline);
            if body_len > max {
                let mut cut = max;
                while !line.is_char_boundary(cut) {
                    cut -= 1;
                }
                line.truncate(cut);
                if had_newline {
                    line.push('\n');
                }
            }
        }
        if let Ok(mut q) = self.log.lines.lock() {
            while q.len() >= self.log.cap {
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
            log: self,
        }
    }
}

static APP_LOG: OnceLock<RecentLog> = OnceLock::new();
static INSTALLED: OnceLock<bool> = OnceLock::new();

/// The apps ring. It is one for each process and it survives an engine
/// rebuild.
pub fn app_log() -> &'static RecentLog {
    APP_LOG.get_or_init(|| RecentLog::with_capacity(APP_RING_CAPACITY, Some(APP_MAX_LINE)))
}

/// `true` when `init` installed the subscriber in this process.
pub fn capture_installed() -> bool {
    INSTALLED.get().copied().unwrap_or(false)
}

/// A boxed layer that fits the bare `Registry`. The apps pass an OS log layer.
pub type OsLayer = Box<dyn Layer<Registry> + Send + Sync>;

/// Install the global subscriber. It returns `true` when it installed it and
/// `false` when a subscriber already existed. A second call returns the first
/// result and does nothing.
pub fn init(os: Option<OsLayer>) -> bool {
    *INSTALLED.get_or_init(|| {
        let os_level = if cfg!(debug_assertions) {
            LevelFilter::INFO
        } else {
            LevelFilter::WARN
        };
        // The OS layer goes first. A boxed `Layer<Registry>` fits only the
        // bare `Registry`.
        let os_layer = os.map(|l| l.with_filter(os_level));
        let ring_filter = Targets::new()
            .with_target("daak", Level::DEBUG)
            .with_default(Level::WARN);
        let ring_layer = tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(app_log().clone())
            .with_span_events(FmtSpan::CLOSE)
            .with_filter(ring_filter);
        let subscriber = registry().with(os_layer).with(ring_layer);
        // Not `try_init`. It also sets a `log` bridge, which can fail for a
        // reason that is not about `tracing`.
        tracing::subscriber::set_global_default(subscriber).is_ok()
    })
}
