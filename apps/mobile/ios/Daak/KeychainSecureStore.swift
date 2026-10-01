import Foundation
import Security
import daak_ffiFFI

// The Daak device identity, in the iOS Keychain as a generic password.
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
      // The iOS-13-and-later default, stated so the store cannot silently fall
      // back to the legacy file-based keychain on an unusual configuration.
      kSecUseDataProtectionKeychain as String: true,
    ]
  }
}
