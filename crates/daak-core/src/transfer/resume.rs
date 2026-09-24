use crate::chunk::ChunkBitmap;

/// Missing-chunk ranges for a NACK reply, as half-open `[start, end)` pairs
/// (end is exclusive, matching `ChunkBitmap::missing_ranges`). A NACK consumer
/// must fetch `start..end` for each entry.
pub fn gaps_to_nack(b: &ChunkBitmap) -> Vec<(u64, u64)> {
    b.missing_ranges()
        .into_iter()
        .map(|r| (r.start, r.end))
        .collect()
}

/// Per-item resume state: the bitmap of chunks already received for one item.
pub struct ResumeState {
    pub received: ChunkBitmap,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::ChunkBitmap;

    #[test]
    fn gaps_convert_to_half_open_ranges() {
        let mut b = ChunkBitmap::new(10);
        b.set(0);
        b.set(1);
        b.set(5);
        b.set(9);
        assert_eq!(gaps_to_nack(&b), vec![(2, 5), (6, 9)]);
    }

    #[test]
    fn complete_bitmap_has_no_gaps() {
        let mut b = ChunkBitmap::new(3);
        for i in 0..3 {
            b.set(i);
        }
        assert!(gaps_to_nack(&b).is_empty());
    }
}
