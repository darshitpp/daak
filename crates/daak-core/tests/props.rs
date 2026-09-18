use proptest::prelude::*;

use daak_core::chunk::ChunkBitmap;
use daak_core::framing::{decode_frame, encode_frame, Frame, RecordType, DEFAULT_MAX_FRAME};
use daak_core::manifest::Manifest;

proptest! {
    #[test]
    fn frame_roundtrip(stream: u32, body in proptest::collection::vec(any::<u8>(), 0..4096)) {
        let f = Frame::new(stream, RecordType::Chunk, bytes::Bytes::from(body));
        let mut buf = encode_frame(&f, DEFAULT_MAX_FRAME).unwrap();
        let got = decode_frame(&mut buf, DEFAULT_MAX_FRAME).unwrap().unwrap();
        prop_assert_eq!(got, f);
    }

    #[test]
    fn bitmap_missing_ranges_are_disjoint_ordered_and_exact(
        count in 0u64..2048,
        set in proptest::collection::vec(any::<bool>(), 0..2048)
    ) {
        let mut b = ChunkBitmap::new(count);
        for (i, s) in set.iter().enumerate().take(count as usize) {
            if *s {
                assert!(b.set(i as u64));
            }
        }
        let ranges = b.missing_ranges();
        let mut prev_end = 0;
        let mut missing = 0u64;
        for r in &ranges {
            prop_assert!(r.start >= prev_end, "overlapping ranges");
            prop_assert!(r.end > r.start);
            missing += r.end - r.start;
            prev_end = r.end;
        }
        let set_count = (0..count).filter(|i| b.is_set(*i)).count() as u64;
        prop_assert_eq!(missing, count - set_count);
    }

    #[test]
    fn manifest_cbor_roundtrip(text in ".*") {
        let m = Manifest::text(&text);
        let decoded = Manifest::from_cbor(&m.to_cbor().unwrap()).unwrap();
        prop_assert_eq!(decoded, m);
    }
}
