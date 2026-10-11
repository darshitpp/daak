use std::ops::Range;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChunkBitmap {
    len: u64,
    words: Vec<u64>,
}

impl ChunkBitmap {
    pub fn new(count: u64) -> Self {
        let words = vec![0u64; count.div_ceil(64) as usize];
        Self { len: count, words }
    }

    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn words_for_persist(&self) -> &[u64] {
        &self.words
    }

    pub fn set_word(&mut self, word_index: usize, word: u64) {
        if word_index < self.words.len() {
            self.words[word_index] = word;
        }
    }

    pub fn set(&mut self, index: u64) -> bool {
        if index >= self.len {
            return false;
        }
        self.words[(index / 64) as usize] |= 1u64 << (index % 64);
        true
    }

    pub fn is_set(&self, index: u64) -> bool {
        index < self.len && self.words[(index / 64) as usize] & (1u64 << (index % 64)) != 0
    }

    pub fn is_complete(&self) -> bool {
        self.len == 0 || self.missing_ranges().is_empty()
    }

    /// How many chunks this bitmap holds. Used to seed resume progress with the
    /// bytes already on disk, so the bar reaches 100%.
    pub fn count_ones(&self) -> u64 {
        self.words.iter().map(|w| w.count_ones() as u64).sum()
    }

    pub fn missing_ranges(&self) -> Vec<Range<u64>> {
        let mut out = Vec::new();
        let mut start: Option<u64> = None;
        for i in 0..self.len {
            if self.is_set(i) {
                if let Some(s) = start.take() {
                    out.push(s..i);
                }
            } else if start.is_none() {
                start = Some(i);
            }
        }
        if let Some(s) = start {
            out.push(s..self.len);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newly_created_bitmap_is_incomplete_with_one_full_range() {
        let b = ChunkBitmap::new(10);
        assert!(!b.is_complete());
        assert_eq!(b.missing_ranges(), vec![0..10]);
        assert_eq!(b.len(), 10);
    }

    #[test]
    fn set_and_query_individual_chunks() {
        let mut b = ChunkBitmap::new(130);
        b.set(0);
        b.set(64);
        b.set(129);
        assert!(b.is_set(0) && b.is_set(64) && b.is_set(129));
        assert!(!b.is_set(1));
        assert_eq!(b.missing_ranges(), vec![1..64, 65..129]);
    }

    #[test]
    fn fully_populated_bitmap_is_complete() {
        let mut b = ChunkBitmap::new(70);
        for i in 0..70 {
            b.set(i);
        }
        assert!(b.is_complete());
        assert!(b.missing_ranges().is_empty());
    }

    #[test]
    fn zero_length_bitmap_is_complete() {
        let b = ChunkBitmap::new(0);
        assert!(b.is_complete());
    }

    #[test]
    fn set_rejects_out_of_range_without_panicking() {
        let mut b = ChunkBitmap::new(5);
        assert!(b.set(3));
        assert!(b.is_set(3));
        assert!(!b.set(b.len()));
        assert!(!b.set(u64::MAX));
        assert!(!b.is_set(b.len()));
        assert_eq!(b.missing_ranges(), vec![0..3, 4..5]);
    }
}
