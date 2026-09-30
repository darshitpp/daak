use std::sync::Arc;

use daak_core::crypto::passphrase_store::PassphraseSecretStore;
use daak_core::crypto::secret_store::{MemorySecretStore, SecretStore};

#[test]
fn wrong_passphrase_is_rejected() {
    let backend: Arc<dyn SecretStore> = Arc::new(MemorySecretStore::default());
    let writer = PassphraseSecretStore::new(backend.clone(), "correct horse battery staple");
    writer.set("identity.x25519.static", &[9u8; 32]).unwrap();

    let reader = PassphraseSecretStore::new(backend, "wrong passphrase");
    assert!(
        reader.get("identity.x25519.static").is_err(),
        "wrong passphrase must fail the AEAD tag"
    );
}

#[test]
fn correct_passphrase_roundtrips_the_identity_blob() {
    let backend: Arc<dyn SecretStore> = Arc::new(MemorySecretStore::default());
    PassphraseSecretStore::new(backend.clone(), "correct horse battery staple")
        .set("identity.ed25519.signing", &[1u8; 32])
        .unwrap();

    let reader = PassphraseSecretStore::new(backend, "correct horse battery staple");
    assert_eq!(
        reader.get("identity.ed25519.signing").unwrap().unwrap(),
        vec![1u8; 32]
    );
}

#[cfg(target_os = "macos")]
#[test]
fn macos_os_store_roundtrips() {
    use daak_core::crypto::os_secret_store::OsSecretStore;
    let store = OsSecretStore::new("dev.darshit.daak.test");
    store.set("roundtrip.key", &[7u8; 32]).unwrap();
    assert_eq!(store.get("roundtrip.key").unwrap().unwrap(), vec![7u8; 32]);
    store.delete("roundtrip.key").unwrap();
    assert!(store.get("roundtrip.key").unwrap().is_none());
}

#[cfg(target_os = "linux")]
#[test]
fn linux_os_store_roundtrips() {
    if std::process::Command::new("secret-tool")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("skipping: secret-tool / Secret Service unavailable");
        return;
    }
    use daak_core::crypto::os_secret_store::OsSecretStore;
    let store = OsSecretStore::new("dev.darshit.daak.test");
    store.set("roundtrip.key", &[7u8; 32]).unwrap();
    assert_eq!(store.get("roundtrip.key").unwrap().unwrap(), vec![7u8; 32]);
    store.delete("roundtrip.key").unwrap();
}
