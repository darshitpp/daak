use std::collections::VecDeque;
use std::sync::Mutex;

/// One local trace record. `at_ms` is the wall-clock time in milliseconds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraceLine {
    pub at_ms: u64,
    pub level: String,
    pub target: String,
    pub message: String,
}

/// A bounded, in-process trace buffer.
///
/// The buffer holds the newest `cap` lines. It drops the oldest line first.
/// Nothing here opens a socket or writes a file. The debug bundle (spec
/// section 7.3) reads `snapshot()` and writes it to a local file the user
/// chooses.
pub struct Observability {
    cap: usize,
    lines: Mutex<VecDeque<TraceLine>>,
}

impl Observability {
    pub fn new(cap: usize) -> Self {
        let cap = cap.max(1);
        Self {
            cap,
            lines: Mutex::new(VecDeque::with_capacity(cap)),
        }
    }

    /// Add one line. When the buffer is full, drop the oldest line.
    pub fn record(&self, line: TraceLine) {
        let mut lines = self.lines.lock().unwrap();
        if lines.len() == self.cap {
            lines.pop_front();
        }
        lines.push_back(line);
    }

    /// Copy every stored line. Oldest line first, newest line last.
    pub fn snapshot(&self) -> Vec<TraceLine> {
        self.lines.lock().unwrap().iter().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.lines.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Default for Observability {
    fn default() -> Self {
        Self::new(1024)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trace_ring_buffer_is_bounded_and_newest_last() {
        let obs = Observability::new(3);
        for i in 0..5 {
            obs.record(TraceLine {
                at_ms: i,
                level: "INFO".into(),
                target: "outbox".into(),
                message: format!("drain {i}"),
            });
        }
        let snap = obs.snapshot();
        assert_eq!(snap.len(), 3, "buffer is capped");
        assert_eq!(snap[0].at_ms, 2, "oldest lines are evicted first");
        assert_eq!(snap[2].at_ms, 4);
    }

    #[test]
    fn snapshot_is_plain_in_memory_state() {
        let obs = Observability::new(8);
        obs.record(TraceLine {
            at_ms: 1,
            level: "WARN".into(),
            target: "presence".into(),
            message: "beacon auth failed".into(),
        });
        let snap = obs.snapshot();
        assert!(matches!(snap, _ if snap.len() == 1));
        assert_eq!(snap[0].target, "presence");
    }
}
