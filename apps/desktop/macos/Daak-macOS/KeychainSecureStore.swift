import Foundation
import Security
import daak_ffiFFI

// The Daak device identity, in the macOS Keychain as a generic password.
//
// This is the UniFFI SecureStore the Rust engine calls DIRECTLY. The
// DaakSecureStore TurboModule in modules/rn-securestore is the JS-facing face of
// the same policy for the app's own small secrets; the code is NOT shared,
// because the app target and the pod cannot import each other.
//
// kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly: readable by the engine's
// background accept loop once the user has unlocked after boot, and NEVER
// restored to another device from a backup -- exactly the property an identity
// key needs, since a restored key would present the same device id on two
// peers. kSecAttrAccessibleWhenUnlocked would put a passcode prompt in front of
// every call the background loop makes, and kSecAttrAccessibleAlways is
// deprecated and readable when the device is off.
@objc(KeychainSecureStore)
final class KeychainSecureStore: NSObject, SecureStore {
  private static let service = "dev.darshit.daak.identity"

  // D16.12.1: the writability probe, the usable flag and the legacy
  // keychain branch are all DELETED, and baseQuery below uses the data-
  // protection keychain unconditionally. What they bought was a store that
  // answered "no" and let the CALLER pick a different store -- a fallback
  // wearing a probe's clothes. The concrete damage: a signed build holds a
  // keychain identity, an ad-hoc build mints a 0600 FILE identity, and from
  // then on the active identity flips with the build signature while both
  // stores coexist. R40(c) wants the start REJECTED, which is exactly what
  // errSecMissingEntitlement on a certificate-less local build produces on its
  // own, and it costs a signed build nothing: the keychain-access-groups
  // entitlement comes from the signature.

  // The uniffi protocol, lowerCamelCase method names with a throwing return.
  // nil is "no such key" (a first launch) and is NOT a failure. Every other
  // OSStatus throws FfiStoreError, so start() rejects (R40(c)): a keystore
  // failure flattened to nil would mint a FRESH identity and silently re-pair
  // the device as a new one.
  func get(key: String) throws -> String? {
    var query = Self.baseQuery(key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    switch status {
    case errSecSuccess:
      guard let data = item as? Data,
            let value = String(data: data, encoding: .utf8)
      else { throw FfiStoreError.Store(reason: "keychain item for \(key) is not UTF-8") }
      return value
    case errSecItemNotFound:
      return nil
    default:
      throw FfiStoreError.Store(reason: "keychain read failed for \(key): \(status)")
    }
  }

  func set(key: String, value: String) throws {
    guard let data = value.data(using: .utf8) else {
      throw FfiStoreError.Store(reason: "value for \(key) is not encodable")
    }
    // SecItemUpdate first, SecItemAdd only when there was nothing to update. The
    // reverse order (add, then update on duplicate) costs a second write and
    // races two callers into a -25299 duplicate-item error.
    let status = SecItemUpdate(
      Self.baseQuery(key) as CFDictionary,
      [kSecValueData as String: data] as CFDictionary)
    if status == errSecSuccess { return }
    guard status == errSecItemNotFound else {
      throw FfiStoreError.Store(reason: "keychain write failed for \(key): \(status)")
    }
    var add = Self.baseQuery(key)
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let addStatus = SecItemAdd(add as CFDictionary, nil)
    guard addStatus == errSecSuccess else {
      throw FfiStoreError.Store(reason: "keychain write failed for \(key): \(addStatus)")
    }
  }

  // Not-found is the ordinary answer for a key that was never written, and it
  // is not a failure: the Rust side treats delete as best-effort.
  func delete(key: String) throws {
    let status = SecItemDelete(Self.baseQuery(key) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw FfiStoreError.Store(reason: "keychain delete failed for \(key): \(status)")
    }
  }

  private static func baseQuery(_ key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
      // NEVER show UI, on any of the three operations. Without this the engine
      // start can BLOCK FOREVER, which is measured and worse than a failure:
      // this host has no signing identity, so the build is ad-hoc, and a
      // legacy-keychain item's ACL is keyed on the code signature that wrote
      // it. Every rebuild is a different ad-hoc signature, so the item the
      // previous build wrote no longer matches and securityd puts up a
      // password dialog on the app's behalf. SecItemCopyMatching then sits in
      // CSSM_DecryptDataFinal -> mach_msg waiting for an answer, start() never
      // settles, and the app renders a dashboard over an engine that never
      // bound a port -- with no error anywhere. See
      // test/macos-inprocess-ffi.spec.ts.
      //
      // kSecUseAuthenticationUIFail turns that dialog into
      // errSecInteractionNotAllowed, which get reports as FfiStoreError and
      // R40(c) REQUIRES to reject the start. A loud refusal beats a silent hang,
      // and no SecItem call in an engine start path should ever be interactive.
      kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail,
      // The data-protection keychain, UNCONDITIONALLY (D16.12.1). There is no
      // if and no fallback: the legacy file keychain it used to degrade to is
      // the one whose per-item ACL causes the dialog above, and a build that
      // could reach it would store the identity somewhere the build before it
      // did not. A build that cannot use this keychain -- no certificate on this
      // host, so no keychain-access-groups entitlement -- fails with
      // errSecMissingEntitlement and the start is REJECTED, which is correct.
      kSecUseDataProtectionKeychain as String: true,
    ]
  }
}
