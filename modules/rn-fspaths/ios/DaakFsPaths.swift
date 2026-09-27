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
    // The engine's data dir, not the OS Documents dir: the database, the keys
    // and every received file live under it, and a caller that resolves
    // documentsDir() and writes a sibling of the received files is writing
    // somewhere the app never looks.
    resolve(Self.dataDir().path)
  }

  /// The engine's RECEIVE ROOT: `<data_dir>/downloads`, which is exactly the
  /// `dir.join("downloads")` out_dir that daak-ffi's start() hands the engine.
  /// Returning bare Documents here -- which is what this did -- meant the UI
  /// listed a directory one level ABOVE where files land, so a received file
  /// existed and was invisible at the same time.
  @objc func downloadsDir(_ resolve: @escaping RCTPromiseResolveBlock,
                          reject: @escaping RCTPromiseRejectBlock) {
    resolve(Self.dataDir().appendingPathComponent("downloads", isDirectory: true).path)
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

  /// `FileManager.fileExists(atPath:)` rather than a stat: it is the same
  /// answer the OS gives a document picker, and it returns false instead of
  /// throwing for a path that is not there. "No such file" is an ANSWER -- a
  /// reveal action must not die on a rejected promise.
  @objc func exists(_ path: String,
                    resolve: @escaping RCTPromiseResolveBlock,
                    reject: @escaping RCTPromiseRejectBlock) {
    resolve(FileManager.default.fileExists(atPath: path))
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

  /// ONE resolution of the engine's data dir, shared with
  /// apps/mobile/ios/Daak.swift's start() by CONSTRUCTION rather than by
  /// convention: both append the same "daak" to the same Documents root. Keep
  /// them in step -- a second copy of this expression is how the two drifted.
  private static func dataDir() -> URL {
    documents().appendingPathComponent("daak", isDirectory: true)
  }
}
