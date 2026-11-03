use std::collections::HashMap;

use super::mdns::PeerAnnounce;

/// What a browse reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveryEvent {
    /// A peer record resolved.
    Found(PeerAnnounce),
    /// The last record of a device is gone. The value is the device id.
    Lost([u8; 16]),
}

/// Tracks which records announce which device.
/// A device is lost only when its last record is gone.
#[derive(Default)]
pub struct RecordTracker {
    by_record: HashMap<String, [u8; 16]>,
}

impl RecordTracker {
    /// Remember that `record` announces `id`. A record name ignores case.
    /// Returns `true` when the record is new, and `false` for a refresh of a
    /// known record.
    pub fn found(&mut self, record: &str, id: [u8; 16]) -> bool {
        self.by_record
            .insert(record.to_ascii_lowercase(), id)
            .is_none()
    }

    /// Forget `record`. Returns `Some(id)` only when no other record names `id`.
    pub fn removed(&mut self, record: &str) -> Option<[u8; 16]> {
        let id = self.by_record.remove(&record.to_ascii_lowercase())?;
        (!self.by_record.values().any(|other| *other == id)).then_some(id)
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_last_record_of_a_device_reports_lost() {
        let mut t = RecordTracker::default();
        t.found("a._daak._tcp", [1; 16]);
        assert_eq!(t.removed("a._daak._tcp"), Some([1; 16]));
    }

    #[test]
    fn a_second_record_keeps_the_device() {
        let mut t = RecordTracker::default();
        t.found("a-en0", [1; 16]);
        t.found("a-en1", [1; 16]);
        assert_eq!(t.removed("a-en0"), None);
        assert_eq!(t.removed("a-en1"), Some([1; 16]));
    }

    #[test]
    fn a_rename_keeps_the_device_when_the_new_record_arrives_first() {
        let mut t = RecordTracker::default();
        t.found("old", [1; 16]);
        t.found("new", [1; 16]);
        assert_eq!(t.removed("old"), None);
    }

    #[test]
    fn found_is_true_for_a_new_record_and_false_for_a_repeat() {
        let mut t = RecordTracker::default();
        assert!(t.found("a._daak._tcp", [1; 16]));
        assert!(!t.found("a._daak._tcp", [1; 16]));
        // A record name ignores case, so this is a repeat too.
        assert!(!t.found("A._daak._tcp", [1; 16]));
        assert!(t.found("b._daak._tcp", [1; 16]));
    }

    #[test]
    fn an_unknown_record_reports_nothing() {
        let mut t = RecordTracker::default();
        assert_eq!(t.removed("never-resolved"), None);
    }

    #[test]
    fn a_record_name_ignores_case() {
        let mut t = RecordTracker::default();
        t.found("A._daak._tcp", [1; 16]);
        assert_eq!(t.removed("a._daak._tcp"), Some([1; 16]));
    }

    #[test]
    fn a_removed_record_is_forgotten() {
        let mut t = RecordTracker::default();
        t.found("a", [1; 16]);
        assert_eq!(t.removed("a"), Some([1; 16]));
        assert_eq!(t.removed("a"), None);
    }
}
