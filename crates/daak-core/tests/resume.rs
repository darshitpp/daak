use daak_core::chunk::ChunkBitmap;
use daak_core::store::Db;
use daak_core::transfer::resume::gaps_to_nack;

#[test]
fn resume_gap_plan_requests_only_missing_ranges() {
    let mut b = ChunkBitmap::new(100);
    for i in 0..40 {
        b.set(i);
    }
    for i in 60..100 {
        b.set(i);
    }
    assert_eq!(gaps_to_nack(&b), vec![(40, 60)]);
}

/// End-to-end: a persisted bitmap reloads under the same payload_id key and
/// still yields only the missing ranges (R-T7-5 key policy).
#[test]
fn persisted_bitmap_roundtrips_into_the_same_gap_plan() {
    let db = Db::open_in_memory().unwrap();
    db.migrate().unwrap();
    let payload_id = [9u8; 16];

    let mut b = ChunkBitmap::new(100);
    for i in 0..40 {
        b.set(i);
    }
    for i in 60..100 {
        b.set(i);
    }
    db.save_bitmap(&payload_id, 0, &b).unwrap();

    let loaded = db.load_bitmap(&payload_id, 0, 100).unwrap();
    assert_eq!(gaps_to_nack(&loaded), vec![(40, 60)]);
    // A different payload id sees nothing: the key really is payload_id.
    let other = db.load_bitmap(&[1u8; 16], 0, 100).unwrap();
    assert_eq!(gaps_to_nack(&other), vec![(0, 100)]);
}
