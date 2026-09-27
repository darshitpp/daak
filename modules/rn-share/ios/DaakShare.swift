import Foundation
import React
import UIKit

private let kDarwinShareInboxChanged = "dev.darshit.daak.share.inbox.changed"

@objc(DaakShare)
class DaakShare: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { true }

  /// The share extension posts this Darwin notification when it has staged
  /// something. Registered so the cross-process wakeup is wired end to end, but
  /// it has NO consumer until Tasks 7/9/11 give it one: the callback
  /// deliberately does nothing, and consumePendingInbox does not consult any
  /// flag. A dead flag that nothing reads is worse than no flag, so there is
  /// none. Until a consumer lands, nothing drains the inbox automatically (R22:
  /// draining with no consumer would delete the batch that names the files).
  override init() {
    super.init()
    CFNotificationCenterAddObserver(
      CFNotificationCenterGetDarwinNotifyCenter(),
      Unmanaged.passUnretained(self).toOpaque(),
      { _, _, _, _, _ in },
      kDarwinShareInboxChanged as CFString, nil, .deliverImmediately)
  }

  // The observer is registered with an unretained self, so it MUST be removed
  // on dealloc or a later post hits freed memory.
  deinit {
    CFNotificationCenterRemoveObserver(
      CFNotificationCenterGetDarwinNotifyCenter(),
      Unmanaged.passUnretained(self).toOpaque(), nil, nil)
  }

  @objc func present(_ text: String, urls: [String], mime: String,
                     resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    var items: [Any] = []
    if !text.isEmpty { items.append(text) }
    items.append(contentsOf: urls.map { URL(fileURLWithPath: $0) as Any })
    DispatchQueue.main.async {
      guard let root = Self.rootViewController() else {
        reject("E_NO_VC", "no root view controller", nil); return
      }
      let vc = UIActivityViewController(activityItems: items, applicationActivities: nil)
      if let pop = vc.popoverPresentationController {
        pop.sourceView = root.view
        pop.sourceRect = CGRect(x: root.view.bounds.midX, y: root.view.bounds.midY, width: 0, height: 0)
      }
      root.present(vc, animated: true) { resolve(nil) }
    }
  }

  @objc func pickDocuments(_ multiple: Bool,
                           resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.data], asCopy: true)
    picker.allowsMultipleSelection = multiple
    let delegate = DocumentPickerDelegate(resolve: resolve, reject: reject)
    objc_setAssociatedObject(picker, &documentPickerDelegateKey, delegate, .OBJC_ASSOCIATION_RETAIN)
    DispatchQueue.main.async {
      guard let root = Self.rootViewController() else {
        reject("E_NO_VC", "no root view controller", nil); return
      }
      root.present(picker, animated: true)
    }
  }

  // App Group drain. Moves staged bytes OUT of the share-inbox and into the
  // app's Documents dir. It does NOT send: the engine outbox owns sending.
  @objc func consumePendingInbox(_ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    let fm = FileManager.default
    guard let container = fm.containerURL(forSecurityApplicationGroupIdentifier: "group.dev.darshit.daak") else {
      resolve("[]")
      return
    }
    let inbox = container.appendingPathComponent("share-inbox", isDirectory: true)
    // Batches have their own subdir so a staged payload file can never be read
    // as metadata. A suffix filter cannot do this: a shared "report.batch" is
    // staged as "<uuid>-report.batch". Scanned non-recursively.
    let batchDir = inbox.appendingPathComponent("batches", isDirectory: true)
    let batches = ((try? fm.contentsOfDirectory(at: batchDir, includingPropertiesForKeys: nil)) ?? [])
    var merged: [[String: String]] = []
    for batch in batches {
      // Delete ONLY after a successful parse: a batch we cannot read holds the
      // only copy of the user's files, so it stays put for a later drain.
      guard let data = try? Data(contentsOf: batch),
            let arr = (try? JSONSerialization.jsonObject(with: data)) as? [[String: String]]
      else { continue }
      // A file item whose move FAILED is still described only by this batch:
      // the relative staged path is meaningless to JS (it has no App Group
      // container URL). Deleting the batch would therefore destroy the last
      // pointer to bytes nothing else can find. So the batch is kept until
      // every file in it has landed in Documents, and its already-moved items
      // are still reported (moveItem is skipped next time for a missing src).
      var allFilesMoved = true
      for var item in arr {
        if item["kind"] == "file", let rel = item["path"],
           let docs = try? fm.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true) {
          let src = inbox.appendingPathComponent(rel)
          let dest = docs.appendingPathComponent(rel)
          let moved: Bool
          if !fm.fileExists(atPath: src.path) && fm.fileExists(atPath: dest.path) {
            // Already moved by an earlier drain that could not retire the batch.
            // The absolute path is the whole reason this can be recognised.
            moved = true
          } else if fm.fileExists(atPath: dest.path) {
            // moveItem fails when dest already exists, so replace instead.
            moved = (try? fm.replaceItemAt(dest, withItemAt: src)) != nil
          } else {
            moved = (try? fm.moveItem(at: src, to: dest)) != nil
          }
          if moved {
            item["path"] = dest.path
          } else {
            allFilesMoved = false
          }
        }
        merged.append(item)
      }
      // ponytail: a file that can never move (disk full, bad Documents path)
      // pins this batch forever and its already-moved items are re-handed to JS
      // on every drain, which becomes duplicate outbox entries once a consumer
      // with no dedupe lands. No byte loss is the deliberate priority here.
      // Upgrade in Tasks 7/9/11: rewrite item["path"] to the absolute dest.path
      // back into the batch so a retry is idempotent, or retire a batch whose
      // only residue is permanently-failed items.
      if allFilesMoved { try? fm.removeItem(at: batch) }
    }
    let json = (try? JSONSerialization.data(withJSONObject: merged)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
    resolve(json)
  }

  /// Drains ONLY `share-inbox/intent-sends/` (R25). A sibling directory of
  /// `batches/`, listed non-recursively, so it physically cannot see or delete
  /// the metadata naming a staged text/file share. consumePendingInbox above is
  /// all-or-nothing by design and stays that way: nothing routes a text/file
  /// item until Task 11, so a drain from the send path would orphan the bytes.
  @objc func consumeIntentSends(_ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    let fm = FileManager.default
    guard let container = fm.containerURL(forSecurityApplicationGroupIdentifier: "group.dev.darshit.daak") else {
      resolve("[]")
      return
    }
    let dir = container.appendingPathComponent("share-inbox/intent-sends", isDirectory: true)
    var merged: [[String: String]] = []
    // Non-recursive, and only the `.json` rename target: a process killed
    // mid-write leaves a `.tmp` that must never be read as a real item.
    let files = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
    for f in files where f.pathExtension == "json" {
      // Delete only after a successful parse, so a corrupt file is retried
      // rather than dropped on the floor.
      guard let data = try? Data(contentsOf: f),
            let arr = (try? JSONSerialization.jsonObject(with: data)) as? [[String: String]]
      else { continue }
      merged.append(contentsOf: arr)
      try? fm.removeItem(at: f)
    }
    let json = (try? JSONSerialization.data(withJSONObject: merged)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
    resolve(json)
  }

  /// The ONLY writer of the App Group `pairedDevices` key (R26). iOS has no
  /// dynamic shortcuts, so the shortcut half of this method is a no-op here;
  /// publishing the peer list here is what makes DaakIntentBridge answer Siri's
  /// entity query without booting Rust. Kept as a conforming implementation
  /// because the Spec is a shared contract -- leaving it out is a compile error.
  @objc func updateShortcutTargets(_ devicesJson: String,
                                   resolve: @escaping RCTPromiseResolveBlock,
                                   reject: @escaping RCTPromiseRejectBlock) {
    guard let data = devicesJson.data(using: .utf8),
          let arr = (try? JSONSerialization.jsonObject(with: data)) as? [[String: String]]
    else {
      reject("E_SHORTCUTS", "devicesJson is not a JSON array of {deviceId,name}", nil)
      return
    }
    // Store JSON DATA, never the array itself. UserDefaults stores a Swift
    // [[String:String]] as a plist ARRAY, and DaakIntentBridge reads it back
    // with data(forKey:) -- which is nil for a plist array, because that is not
    // a Data value. The pair was compiled and run: the plist-array writer makes
    // devices() return [] unconditionally, i.e. Siri sees zero devices. This
    // exact data(forKey:) + JSONSerialization round-trip is what fixes it.
    // `[]` is a real answer: an unpaired peer must stop being offered to Siri.
    guard let data = try? JSONSerialization.data(withJSONObject: arr) else {
      reject("E_SHORTCUTS", "devicesJson is not JSON-serializable", nil)
      return
    }
    UserDefaults(suiteName: "group.dev.darshit.daak")?.set(data, forKey: "pairedDevices")
    resolve(nil)
  }

  private static func rootViewController() -> UIViewController? {
    UIApplication.shared.connectedScenes
      .compactMap { ($0 as? UIWindowScene)?.keyWindow }
      .first?.rootViewController
  }
}

private var documentPickerDelegateKey: UInt8 = 0

final class DocumentPickerDelegate: NSObject, UIDocumentPickerDelegate {
  let resolve: RCTPromiseResolveBlock
  let reject: RCTPromiseRejectBlock
  init(resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    self.resolve = resolve; self.reject = reject
  }
  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    resolve(urls.map { $0.path })
  }
  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { resolve([]) }
}
