import Foundation
import React

/// Every path this module hands out is an APP-SANDBOX path. The engine's data
/// dir and every saved file live here, so a caller can never steer the engine
/// outside the sandbox by passing a dir in.
@objc(DaakFsPaths)
class DaakFsPaths: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc func documentsDir(_ resolve: @escaping RCTPromiseResolveBlock,
                          reject: @escaping RCTPromiseRejectBlock) {
    resolve(Self.documents().path)
  }

  /// iOS has no separate downloads dir an app may write without a UIFileSharing
  /// entitlement, so the honest answer is the app's own Documents. It is inside
  /// the sandbox, which is the invariant callers actually depend on.
  @objc func downloadsDir(_ resolve: @escaping RCTPromiseResolveBlock,
                          reject: @escaping RCTPromiseRejectBlock) {
    resolve(Self.documents().path)
  }

  @objc func appGroupDir(_ resolve: @escaping RCTPromiseResolveBlock,
                         reject: @escaping RCTPromiseRejectBlock) {
    let container = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: "group.dev.darshit.daak")
    // "" is an answer, not a failure: the App Group entitlement may be absent
    // on a mis-built target, and a relative path would be worse than nothing.
    resolve(container?.path ?? "")
  }

  /// DELIBERATELY A NO-OP, and it resolves `false` (R41).
  ///
  /// Revealing a file in Finder needs UIFileSharingEnabled +
  /// LSSupportsOpeningDocumentsInPlace, and even then there is no public API to
  /// select a file in the Files app -- QLPreviewController can only present a
  /// preview the user then has to navigate out of. Presenting that as "reveal"
  /// would be a lie the user discovers by tapping. The notification action
  /// `daak.folder` is therefore still WITHHELD from the installed category
  /// (DAK_REGISTERED_ACTIONS), so this is unreachable from the UI.
  @objc func reveal(_ path: String,
                    resolve: @escaping RCTPromiseResolveBlock,
                    reject: @escaping RCTPromiseRejectBlock) {
    resolve(false)
  }

  private static func documents() -> URL {
    // create: true, so a first launch has a directory and not a promise of one.
    let fm = FileManager.default
    if let url = try? fm.url(for: .documentDirectory, in: .userDomainMask,
                            appropriateFor: nil, create: true) {
      return url
    }
    // A device with no writable Documents would be unusable for a file app;
    // the cache dir is at least inside the same sandbox.
    return fm.urls(for: .cachesDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
  }
}
