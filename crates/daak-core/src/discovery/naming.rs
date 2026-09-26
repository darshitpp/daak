use rand::Rng;

use crate::error::{CoreError, Result};
use crate::wordlist::{ADJECTIVES, ANIMALS};

pub fn default_display_name() -> Result<String> {
    hostname::get()
        .map_err(|e| CoreError::Naming(e.to_string()))
        .map(|h| h.to_string_lossy().into_owned())
        .and_then(|h| {
            if h.trim().is_empty() {
                Err(CoreError::Naming("hostname is empty".into()))
            } else {
                Ok(h)
            }
        })
}

pub fn unique_display_name(base: &str, taken: &[String], rng: &mut impl Rng) -> String {
    if !taken.iter().any(|t| t == base) {
        return base.to_string();
    }
    // ponytail: ceiling is the 16x16 wordlist -- 64 tries, then a numeric suffix
    // outside the wordlist space, so a LAN advertising every wordlist name cannot
    // hang startup. Upgrade path: bigger wordlist and/or a random token suffix.
    for _ in 0..64 {
        let adj = ADJECTIVES[rng.gen_range(0..ADJECTIVES.len())];
        let animal = ANIMALS[rng.gen_range(0..ANIMALS.len())];
        let candidate = format!("{adj} {animal} · {base}");
        if !taken.iter().any(|t| t == &candidate) {
            return candidate;
        }
    }
    for n in 2..u32::MAX {
        let candidate = format!("{base} {n}");
        if !taken.iter().any(|t| t == &candidate) {
            return candidate;
        }
    }
    unreachable!("every numeric suffix taken")
}

/// The name decision behind [`crate::discovery::Advertiser::start_resolving`],
/// split out so it is testable without opening an mDNS socket.
pub fn resolve_name(base: &str, observed: &[String], rng: &mut impl Rng) -> String {
    unique_display_name(base, observed, rng)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    #[test]
    fn unique_name_is_returned_unchanged() {
        let mut rng = rand::rngs::StdRng::seed_from_u64(1);
        let got = unique_display_name("Pixel 9", &["Other".to_string()], &mut rng);
        assert_eq!(got, "Pixel 9");
    }

    #[test]
    fn collision_produces_adjective_animal_suffix() {
        let mut rng = rand::rngs::StdRng::seed_from_u64(7);
        let taken = vec!["Pixel 9".to_string()];
        let got = unique_display_name("Pixel 9", &taken, &mut rng);
        assert!(got.ends_with(" · Pixel 9"), "got {got}");
        let prefix = got.trim_end_matches(" · Pixel 9");
        let parts: Vec<&str> = prefix.split(' ').collect();
        assert_eq!(parts.len(), 2);
        assert!(ADJECTIVES.contains(&parts[0]));
        assert!(ANIMALS.contains(&parts[1]));
    }
}

#[cfg(test)]
mod more_tests {
    use super::*;
    use rand::SeedableRng;

    #[test]
    fn repeated_collisions_keep_generating_new_names() {
        let mut rng = rand::rngs::StdRng::seed_from_u64(11);
        let mut taken = vec!["Phone".to_string()];
        for _ in 0..20 {
            let n = unique_display_name("Phone", &taken, &mut rng);
            assert!(n.ends_with(" · Phone"));
            assert!(!taken.contains(&n), "generated a duplicate: {n}");
            taken.push(n);
        }
    }

    #[test]
    fn resolve_name_keeps_base_when_free() {
        let mut rng = rand::rngs::StdRng::seed_from_u64(3);
        let observed = vec!["Laptop".to_string(), "Tablet".to_string()];
        assert_eq!(resolve_name("Phone", &observed, &mut rng), "Phone");
    }

    #[test]
    fn resolve_name_avoids_observed_names() {
        let mut rng = rand::rngs::StdRng::seed_from_u64(5);
        let observed = vec!["Phone".to_string()];
        let got = resolve_name("Phone", &observed, &mut rng);
        assert!(got.ends_with(" · Phone"), "got {got}");
        assert!(!observed.contains(&got));
    }

    #[test]
    fn full_wordlist_falls_back_outside_it() {
        let mut rng = rand::rngs::StdRng::seed_from_u64(13);
        let mut taken: Vec<String> = vec!["Phone".to_string()];
        for a in ADJECTIVES {
            for an in ANIMALS {
                taken.push(format!("{a} {an} · Phone"));
            }
        }
        let got = unique_display_name("Phone", &taken, &mut rng);
        assert!(!taken.contains(&got), "returned a taken name: {got}");
        assert!(!ADJECTIVES.contains(&got.split_whitespace().next().unwrap()));
    }
}
