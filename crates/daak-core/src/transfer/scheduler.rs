use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledItem {
    pub index: u32,
    pub path: PathBuf,
    pub chunk_size: u32,
    pub chunk_count: u64,
}

/// Round-robin chunk order: 'quantum' chunks per item, cycling until exhausted.
/// Output is ordered (item_index, chunk_index) pairs, so items with fewer
/// chunks finish their stream early.
pub fn interleave(items: Vec<ScheduledItem>, quantum: u32) -> Vec<(u32, u64)> {
    let quantum = quantum.max(1) as u64;
    let mut cursors: Vec<(u32, u64, u64)> = items
        .iter()
        .map(|i| (i.index, 0u64, i.chunk_count))
        .collect();
    let mut out = Vec::new();
    let mut remaining = true;
    while remaining {
        remaining = false;
        for (index, cursor, count) in cursors.iter_mut() {
            if *cursor >= *count {
                continue;
            }
            remaining = true;
            let end = (*cursor + quantum).min(*count);
            for c in *cursor..end {
                out.push((*index, c));
            }
            *cursor = end;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn item(index: u32, chunks: u64) -> ScheduledItem {
        ScheduledItem {
            index,
            path: PathBuf::from("x"),
            chunk_size: 1024,
            chunk_count: chunks,
        }
    }

    #[test]
    fn small_item_completes_before_large_item_finishes() {
        let order = interleave(vec![item(0, 10), item(1, 2)], 1);
        // Both of item 1's chunks must appear before item 0's last chunk.
        let pos_1_last = order.iter().rposition(|(i, _)| *i == 1).unwrap();
        let pos_0_last = order.iter().rposition(|(i, _)| *i == 0).unwrap();
        assert!(pos_1_last < pos_0_last, "order was {order:?}");
    }

    #[test]
    fn every_chunk_is_emitted_exactly_once() {
        let order = interleave(vec![item(0, 3), item(1, 5)], 2);
        assert_eq!(order.len(), 8);
        let mut sorted = order.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 8, "duplicate or missing chunks");
    }
}
