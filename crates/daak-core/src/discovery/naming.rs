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
    loop {
        let adj = ADJECTIVES[rng.gen_range(0..ADJECTIVES.len())];
        let animal = ANIMALS[rng.gen_range(0..ANIMALS.len())];
        let candidate = format!("{adj} {animal} · {base}");
        if !taken.iter().any(|t| t == &candidate) {
            return candidate;
        }
    }
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
