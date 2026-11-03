//! The OS log layer must see every span. `tracing-oslog` reads the current
//! span in `on_event` and panics when the span is not in its context. The
//! release profile aborts on a panic. This test is in its own binary, because
//! `diag::init` sets the global subscriber for the process.
//!
//! Run it in both profiles. A release run makes `cfg!(debug_assertions)`
//! false, so `init` uses the WARN level for the OS layer.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tracing::span::{Attributes, Id};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::registry::LookupSpan;

/// The probe uses the same lookup as `tracing-oslog` (logger.rs:162-166).
struct OsLogProbe {
    events: Arc<AtomicUsize>,
}

impl<S> Layer<S> for OsLogProbe
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, _attrs: &Attributes<'_>, _id: &Id, _ctx: Context<'_, S>) {}

    fn on_event(&self, _event: &Event<'_>, ctx: Context<'_, S>) {
        if let Some(parent_id) = ctx.current_span().id() {
            ctx.span(parent_id)
                .expect("invalid span, this shouldn't happen");
        }
        self.events.fetch_add(1, Ordering::SeqCst);
    }
}

#[test]
fn a_warn_event_inside_an_info_span_reaches_the_os_layer() {
    let events = Arc::new(AtomicUsize::new(0));
    let probe = OsLogProbe {
        events: events.clone(),
    };
    assert!(daak_core::diag::init(Some(Box::new(probe))));

    // The target must start with `daak`. Then the ring layer enables the span,
    // and the registry makes it, as for the engine spans. With a test crate
    // target, every layer rejects the span, and the test proves nothing.
    let span = tracing::info_span!(target: "daak_core::engine", "outbox_drain");
    let _guard = span.enter();
    tracing::warn!(target: "daak_core::engine", "outbox drain: send failed");

    assert_eq!(events.load(Ordering::SeqCst), 1);
}
