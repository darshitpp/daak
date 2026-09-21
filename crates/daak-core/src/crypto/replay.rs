use crate::error::Result;
use crate::store::Db;

/// Sliding replay window over sender counters.
///
/// `seen` is a multi-word bitmap: word `w` bit `b` records that counter
/// `max - (64 * w + b)` was already accepted. A single `u64` is insufficient
/// at the mandated default size (4096), where frames more than 63 counters
/// behind the max would otherwise overflow `1u64 << diff`.
#[derive(Debug, Clone)]
pub struct ReplayWindow {
    size: u64,
    max: u64,
    seen: Vec<u64>,
    initialized: bool,
}

impl ReplayWindow {
    pub fn new(size: u32) -> Self {
        let size = size as u64;
        let words = (size.div_ceil(64)).max(1) as usize;
        Self {
            size,
            max: 0,
            seen: vec![0; words],
            initialized: false,
        }
    }

    fn words(&self) -> usize {
        self.seen.len()
    }

    fn zero_all(&mut self) {
        for w in self.seen.iter_mut() {
            *w = 0;
        }
    }

    /// Shift the whole bitmap left by `shift` bits across words. `shift` is
    /// always `< self.size` when called, so bits that fall outside the window
    /// are simply dropped (never written into word indexes >= `words`).
    fn shift_left(&mut self, shift: u64) {
        if shift == 0 {
            return;
        }
        let n = self.words();
        let word_shift = (shift / 64) as usize;
        let bit_shift = shift % 64;
        if word_shift >= n {
            self.zero_all();
            return;
        }
        // High word to low so each source word is read before it is written.
        if bit_shift == 0 {
            for i in (word_shift..n).rev() {
                self.seen[i] = self.seen[i - word_shift];
            }
            for i in 0..word_shift {
                self.seen[i] = 0;
            }
        } else {
            for i in (0..n).rev() {
                let mut v = 0u64;
                if i >= word_shift {
                    v |= self.seen[i - word_shift] << bit_shift;
                }
                if i > word_shift {
                    v |= self.seen[i - word_shift - 1] >> (64 - bit_shift);
                }
                self.seen[i] = v;
            }
        }
    }

    pub fn accept(&mut self, counter: u64) -> bool {
        if !self.initialized {
            self.initialized = true;
            self.max = counter;
            self.zero_all();
            self.seen[0] = 1;
            return true;
        }
        if counter > self.max {
            let shift = counter - self.max;
            if shift >= self.size {
                self.zero_all();
            } else {
                self.shift_left(shift);
            }
            self.max = counter;
            self.seen[0] |= 1;
            return true;
        }
        let diff = self.max - counter;
        if diff >= self.size {
            return false;
        }
        let word = (diff / 64) as usize;
        let bit = diff % 64;
        let mask = 1u64 << bit;
        if self.seen[word] & mask != 0 {
            return false;
        }
        self.seen[word] |= mask;
        true
    }

    pub fn persist(&self, db: &Db, peer: &[u8; 16], dir: &str) -> Result<()> {
        let mut blob = Vec::with_capacity(self.words() * 8);
        for w in &self.seen {
            blob.extend_from_slice(&w.to_be_bytes());
        }
        db.conn().execute(
            r#"INSERT INTO replay_guard (peer_device_id, direction, max_counter, epoch, seen)
               VALUES (?1, ?2, ?3, 0, ?4)
               ON CONFLICT(peer_device_id, direction) DO UPDATE SET
                 max_counter = excluded.max_counter,
                 seen = excluded.seen"#,
            rusqlite::params![&peer[..], dir, self.max as i64, blob],
        )?;
        Ok(())
    }

    pub fn load(db: &Db, peer: &[u8; 16], dir: &str) -> Result<Self> {
        let mut stmt = db.conn().prepare(
            "SELECT max_counter, seen FROM replay_guard WHERE peer_device_id = ?1 AND direction = ?2",
        )?;
        let mut rows = stmt.query(rusqlite::params![&peer[..], dir])?;
        if let Some(r) = rows.next()? {
            let max: i64 = r.get(0)?;
            let blob: Vec<u8> = r.get(1)?;
            let mut w = Self::new(4096);
            if blob.len() == w.words() * 8 {
                for (i, word) in w.seen.iter_mut().enumerate() {
                    let start = i * 8;
                    *word = u64::from_be_bytes(blob[start..start + 8].try_into().unwrap());
                }
            } else {
                // Legacy row persisted only `max`: accept that counter and nothing else.
                w.seen[0] = 1;
            }
            w.initialized = true;
            w.max = max as u64;
            return Ok(w);
        }
        Ok(Self::new(4096))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_in_order_and_rejects_replays() {
        let mut w = ReplayWindow::new(16);
        assert!(w.accept(0));
        assert!(w.accept(1));
        assert!(!w.accept(1), "duplicate must be rejected");
        assert!(!w.accept(0), "old must be rejected");
    }

    #[test]
    fn accepts_out_of_order_within_window() {
        let mut w = ReplayWindow::new(16);
        assert!(w.accept(5));
        assert!(w.accept(3));
        assert!(w.accept(4));
        assert!(!w.accept(3));
    }

    #[test]
    fn rejects_too_old_counters() {
        let mut w = ReplayWindow::new(8);
        assert!(w.accept(100));
        assert!(!w.accept(80), "outside window must be rejected");
        assert!(w.accept(93), "inside window must be accepted");
    }

    #[test]
    fn default_size_window_handles_far_counters_without_overflow() {
        let mut w = ReplayWindow::new(4096);
        assert!(w.accept(10_000));
        assert!(w.accept(9_900), "100 behind must be inside the window");
        assert!(!w.accept(9_900), "replay must be rejected");
        assert!(w.accept(10_000 - 4095), "still inside the window");
        assert!(!w.accept(10_000 - 4096), "outside the window");
    }

    #[test]
    fn persist_and_load_roundtrip_rejects_replays() {
        let db = crate::store::Db::open_in_memory().unwrap();
        db.migrate().unwrap();
        let peer = [7u8; 16];
        let mut w = ReplayWindow::new(4096);
        assert!(w.accept(500));
        assert!(w.accept(400));
        w.persist(&db, &peer, "recv").unwrap();

        let mut back = ReplayWindow::load(&db, &peer, "recv").unwrap();
        assert!(
            !back.accept(400),
            "already-accepted counter must stay rejected after reload"
        );
        assert!(
            !back.accept(500),
            "the max counter must stay rejected after reload"
        );
        assert!(back.accept(501), "a fresh counter must still be accepted");
    }
}
