use std::collections::HashMap;
use std::sync::Mutex;

/// Hot UI-only key/value cache. Correctness never depends on it: the SQLite
/// `settings` table is the source of truth and the fallback below always works.
pub trait HotCache: Send + Sync {
    fn get(&self, key: &str) -> Option<Vec<u8>>;
    fn put(&self, key: &str, value: Vec<u8>);
    fn remove(&self, key: &str);
}

#[derive(Default)]
pub struct MemoryHotCache {
    map: Mutex<HashMap<String, Vec<u8>>>,
}

impl HotCache for MemoryHotCache {
    fn get(&self, key: &str) -> Option<Vec<u8>> {
        self.map
            .lock()
            .expect("cache lock poisoned")
            .get(key)
            .cloned()
    }
    fn put(&self, key: &str, value: Vec<u8>) {
        self.map
            .lock()
            .expect("cache lock poisoned")
            .insert(key.to_string(), value);
    }
    fn remove(&self, key: &str) {
        self.map.lock().expect("cache lock poisoned").remove(key);
    }
}

pub struct MmkvHotCache {
    fallback: MemoryHotCache,
    backend: Option<Box<dyn HotCache>>,
}

impl MmkvHotCache {
    pub fn new(backend: Option<Box<dyn HotCache>>) -> Self {
        Self {
            fallback: MemoryHotCache::default(),
            backend,
        }
    }
}

impl HotCache for MmkvHotCache {
    /// A backend, once attached, is the only store: never fall through to the
    /// fallback, or a key removed through the backend would read back as a
    /// stale value written before the backend existed.
    fn get(&self, key: &str) -> Option<Vec<u8>> {
        match &self.backend {
            Some(b) => b.get(key),
            None => self.fallback.get(key),
        }
    }
    fn put(&self, key: &str, value: Vec<u8>) {
        match &self.backend {
            Some(b) => b.put(key, value),
            None => self.fallback.put(key, value),
        }
    }
    fn remove(&self, key: &str) {
        match &self.backend {
            Some(b) => b.remove(key),
            None => self.fallback.remove(key),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mmkv_cache_uses_fallback_when_backend_absent() {
        let cache = MmkvHotCache::new(None);
        cache.put("last_peer", b"deadbeef".to_vec());
        assert_eq!(cache.get("last_peer"), Some(b"deadbeef".to_vec()));
        cache.remove("last_peer");
        assert_eq!(cache.get("last_peer"), None);
    }

    #[test]
    fn mmkv_cache_prefers_the_backend_when_present() {
        let cache = MmkvHotCache::new(Some(Box::new(MemoryHotCache::default())));
        cache.put("k", b"v".to_vec());
        assert_eq!(cache.get("k"), Some(b"v".to_vec()));
    }

    /// Regression: a value written while there was no backend must not be
    /// readable (nor resurrect after remove) once a backend is attached.
    #[test]
    fn fallback_value_is_invisible_once_a_backend_is_attached() {
        let mut cache = MmkvHotCache::new(None);
        cache.put("k", b"stale".to_vec());

        cache.backend = Some(Box::new(MemoryHotCache::default()));
        assert_eq!(
            cache.get("k"),
            None,
            "backend is the only store once attached"
        );

        cache.put("k", b"fresh".to_vec());
        cache.remove("k");
        assert_eq!(
            cache.get("k"),
            None,
            "remove is not shadowed by the fallback"
        );
    }
}
