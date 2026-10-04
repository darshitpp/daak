import Foundation
import React
import Security

// The Daak device identity, in the iOS Keychain as a generic password.
//
// kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly: readable by the engine's
// background accept loop once the user has unlocked after boot, and NEVER
// restored to another device from a backup -- which is exactly the property an
// identity key needs, since a restored key on a second device would present
// the same device id on two peers. kSecAttrAccessibleWhenUnlocked would put a
// passcode prompt in front of every call the background loop makes, and
// kSecAttrAccessibleAlways is deprecated and unlocked-when-off.
//
// kSecUseDataProtectionKeychain is the iOS-13-and-later default and is stated
// so the store does not silently fall back to the legacy file-based keychain on
// an unusual configuration. It has NO macOS equivalent, so it is stated only
// where it exists -- see baseQuery below.
//
// This file is the iOS AND macOS implementation, unchanged between them: the
// generic-password item, the service string and the accessibility class are all
// the same on both, and macOS reaches the login keychain the same way. The one
// difference is the data-protection flag below.
@objc(DaakSecureStore)
class DaakSecureStore: NSObject {
  private static let service = "dev.darshit.daak.identity"

  @objc static func requiresMainQueueSetup() -> Bool { false }

  // nil is "no such key" (a first launch) and resolves normally. A REJECT is a
  // keychain that cannot be read, and it is deliberately NOT flattened to nil:
  // the caller is the engine constructor, and a silent nil would mint a FRESH
  // identity and re-pair the device as a new one (R40(c)).
  @objc func get(_ key: String,
                 resolve: @escaping RCTPromiseResolveBlock,
                 reject: @escaping RCTPromiseRejectBlock) {
    var query = Self.baseQuery(key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    switch status {
    case errSecSuccess:
      guard let data = item as? Data,
            let value = String(data: data, encoding: .utf8)
      else {
        reject("E_KEYCHAIN", "keychain item for \(key) is not UTF-8", nil)
        return
      }
      resolve(value)
    case errSecItemNotFound:
      resolve(nil)
    default:
      reject("E_KEYCHAIN", "keychain read failed for \(key): \(status)", nil)
    }
  }

  @objc func set(_ key: String, value: String,
                 resolve: @escaping RCTPromiseResolveBlock,
                 reject: @escaping RCTPromiseRejectBlock) {
    guard let data = value.data(using: .utf8) else {
      reject("E_KEYCHAIN", "value for \(key) is not encodable", nil)
      return
    }
    // SecItemUpdate first, SecItemAdd only when there was nothing to update. The
    // reverse order (add, then update on duplicate) costs a second write and
    // races two callers into a -25299 duplicate-item error.
    let status = SecItemUpdate(
      Self.baseQuery(key) as CFDictionary,
      [kSecValueData as String: data] as CFDictionary)
    if status == errSecSuccess {
      resolve(true)
      return
    }
    guard status == errSecItemNotFound else {
      reject("E_KEYCHAIN", "keychain write failed for \(key): \(status)", nil)
      return
    }
    var add = Self.baseQuery(key)
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let addStatus = SecItemAdd(add as CFDictionary, nil)
    if addStatus == errSecSuccess {
      resolve(true)
    } else {
      reject("E_KEYCHAIN", "keychain write failed for \(key): \(addStatus)", nil)
    }
  }

  @objc func remove(_ key: String,
                    resolve: @escaping RCTPromiseResolveBlock,
                    reject: @escaping RCTPromiseRejectBlock) {
    let status = SecItemDelete(Self.baseQuery(key) as CFDictionary)
    // Not-found is the ordinary answer for a key that was never written, so it
    // resolves true rather than rejecting a delete that achieved its goal.
    if status == errSecSuccess || status == errSecItemNotFound {
      resolve(true)
    } else {
      reject("E_KEYCHAIN", "keychain delete failed for \(key): \(status)", nil)
    }
  }

  private static func baseQuery(_ key: String) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
    ]
    // kSecUseDataProtectionKeychain, and ONLY where it exists. The constant is
    // iOS 13+ with no macOS equivalent: the data-protection keychain is a device
    // concept, and a macOS keychain item is already scoped to the login keychain
    // and encrypted with the login key. Stating it unconditionally is exactly
    // what this guard prevents -- the same source file compiles for both
    // platforms (modules/rn-securestore/DaakSecureStore.podspec), and without the
    // guard the macOS build fails on an unrecognised selector.
    #if os(iOS)
    query[kSecUseDataProtectionKeychain as String] = true
    #endif
    return query
  }
}
