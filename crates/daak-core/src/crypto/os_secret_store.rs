//! The OS keystore, as one `SecretStore` per platform.
//!
//! A keystore failure is an ERROR, never a miss: a `get` that reported
//! "absent" for a locked keychain would make `import_from_store` mint a FRESH
//! Ed25519 identity, and the device would silently re-pair as a new one with
//! every stored pairing row still pointing at the old id. Same rule as
//! daak-ffi's `FfiSecretStore` (R40(c)).
//!
//! Every target therefore HAS an impl. The catch-all at the bottom is not an
//! optional extra: without it, a target with no arm above (iOS, Android) has
//! no `SecretStore for OsSecretStore` at all and the `Arc::new(..) as
//! Arc<dyn SecretStore>` coercion in `platform_secret_store` is a hard E0277
//! -- taking the whole mobile build down, which CI on ubuntu-latest never
//! notices because it takes the Linux arm.

use crate::crypto::secret_store::SecretStore;
use crate::error::{CoreError, Result};

pub struct OsSecretStore {
    /// Read by the macOS and Linux arms, which pass it to Keychain and
    /// `secret-tool` as the service name. The Windows arm never reads it --
    /// it keys by `<key>.bin` under `dir` and only DPAPI-wraps the blob -- and
    /// neither does the mobile catch-all. `new` still takes the service so ONE
    /// constructor serves every target, hence the cfg-conditional allow rather
    /// than a field whose shape changes per target.
    #[cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(dead_code))]
    service: String,
    #[cfg(target_os = "windows")]
    dir: std::path::PathBuf,
}

impl OsSecretStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
            #[cfg(target_os = "windows")]
            dir: std::env::var_os("LOCALAPPDATA")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(std::env::temp_dir)
                .join("Daak")
                .join("secrets"),
        }
    }
}

// There is no mobile backend to report: every desktop arm uses this, but the
// iOS/Android catch-all builds its own CoreError inline, so this function is
// not part of that build at all rather than unused there.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn backend_err<E: std::fmt::Display>(e: E) -> CoreError {
    CoreError::Io(std::io::Error::other(e.to_string()))
}

#[cfg(target_os = "macos")]
impl SecretStore for OsSecretStore {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        match security_framework::passwords::get_generic_password(&self.service, key) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.code() == -25300 => Ok(None), // errSecItemNotFound
            Err(e) => Err(backend_err(e)),
        }
    }
    fn set(&self, key: &str, value: &[u8]) -> Result<()> {
        security_framework::passwords::set_generic_password(&self.service, key, value)
            .map_err(backend_err)
    }
    fn delete(&self, key: &str) -> Result<()> {
        match security_framework::passwords::delete_generic_password(&self.service, key) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == -25300 => Ok(()),
            Err(e) => Err(backend_err(e)),
        }
    }
}

#[cfg(target_os = "windows")]
fn dpapi_blob(value: &[u8]) -> Result<Vec<u8>> {
    use windows::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    let mut input = CRYPT_INTEGER_BLOB {
        cbData: value.len() as u32,
        pbData: value.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe { CryptProtectData(&mut input, None, None, None, None, 0, &mut output) }
        .map_err(backend_err)?;
    let out = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        windows::Win32::System::Memory::LocalFree(Some(windows::Win32::Foundation::HLOCAL(
            output.pbData as *mut _,
        )))
    };
    Ok(out)
}

#[cfg(target_os = "windows")]
fn dpapi_unblob(blob: &[u8]) -> Result<Vec<u8>> {
    use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    let mut input = CRYPT_INTEGER_BLOB {
        cbData: blob.len() as u32,
        pbData: blob.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe { CryptUnprotectData(&mut input, None, None, None, None, 0, &mut output) }
        .map_err(backend_err)?;
    let out = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        windows::Win32::System::Memory::LocalFree(Some(windows::Win32::Foundation::HLOCAL(
            output.pbData as *mut _,
        )))
    };
    Ok(out)
}

#[cfg(target_os = "windows")]
impl SecretStore for OsSecretStore {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        match std::fs::read(self.dir.join(format!("{key}.bin"))) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
            Ok(blob) => Ok(Some(dpapi_unblob(&blob)?)),
        }
    }
    fn set(&self, key: &str, value: &[u8]) -> Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        std::fs::write(self.dir.join(format!("{key}.bin")), dpapi_blob(value)?)?;
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<()> {
        match std::fs::remove_file(self.dir.join(format!("{key}.bin"))) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(target_os = "linux")]
impl SecretStore for OsSecretStore {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        use base64::Engine as _;
        let out = std::process::Command::new("secret-tool")
            .args(["lookup", "service", &self.service, "account", key])
            .output()
            .map_err(backend_err)?;
        // ONLY "failed silently" is "not set". secret-tool exits non-zero
        // with NO output at all for a genuine miss, and exits non-zero WITH a
        // diagnostic for a locked keyring, an unreachable D-Bus or a dead
        // gnome-keyring daemon. Reading that second case as Ok(None) is the
        // mint-a-new-identity hazard the module doc describes, one layer
        // down, so only the silent failure is a miss. Erring on a miss that
        // printed a diagnostic is the safe direction: a loud refusal, not a
        // new device.
        if !out.status.success() {
            if !out.stderr.is_empty() {
                return Err(CoreError::Io(std::io::Error::other(format!(
                    "secret-tool lookup failed: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ))));
            }
            return Ok(None);
        }
        if out.stdout.is_empty() {
            return Ok(None);
        }
        base64::engine::general_purpose::STANDARD
            .decode(
                out.stdout
                    .iter()
                    .copied()
                    .filter(|b| !b.is_ascii_whitespace())
                    .collect::<Vec<u8>>(),
            )
            .map(Some)
            .map_err(backend_err)
    }
    fn set(&self, key: &str, value: &[u8]) -> Result<()> {
        use base64::Engine as _;
        use std::io::Write as _;
        let mut child = std::process::Command::new("secret-tool")
            .args([
                "store",
                "--label",
                "Daak identity",
                "service",
                &self.service,
                "account",
                key,
            ])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(backend_err)?;
        child
            .stdin
            .as_mut()
            .expect("piped stdin")
            .write_all(
                base64::engine::general_purpose::STANDARD
                    .encode(value)
                    .as_bytes(),
            )
            .map_err(backend_err)?;
        let status = child.wait().map_err(backend_err)?;
        if status.success() {
            Ok(())
        } else {
            Err(CoreError::Io(std::io::Error::other(
                "secret-tool store failed",
            )))
        }
    }
    fn delete(&self, key: &str) -> Result<()> {
        let _ = std::process::Command::new("secret-tool")
            .args(["clear", "service", &self.service, "account", key])
            .output();
        Ok(())
    }
}

/// Every target that is not macOS, Windows or desktop Linux -- which is
/// exactly iOS and Android, where the identity keystore is the PLATFORM
/// BINDING's job (KeychainSecureStore in Daak.swift, KeystoreSecureStore in
/// DaakModule.kt) and is handed to the engine through the UDL's `SecureStore`
/// callback instead of being reached from Rust.
///
/// The methods exist so the type is well-formed everywhere and the compile
/// succeeds; they must never be CALLED on mobile, because every one of them is
/// a loud failure by design. `get` returns Err and never Ok(None): an
/// Ok(None) here means "this device has no identity yet", which is the one
/// answer that makes `import_from_store` mint a brand-new Ed25519 identity and
/// silently re-pair the device as a new one (R40(a)/R40(c)).
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
impl SecretStore for OsSecretStore {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        Err(unsupported(key))
    }
    fn set(&self, key: &str, _value: &[u8]) -> Result<()> {
        Err(unsupported(key))
    }
    fn delete(&self, key: &str) -> Result<()> {
        Err(unsupported(key))
    }
}

/// Names the platform in the message, so a mobile developer reading the log
/// learns WHY rather than seeing a bare failure. The key is included for the
/// same reason: a keystore error is per-key.
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn unsupported(key: &str) -> CoreError {
    CoreError::Io(std::io::Error::other(format!(
        "no OS keystore in daak-core on {}; the platform binding must supply \
         the identity store (key {key:?})",
        std::env::consts::OS
    )))
}
