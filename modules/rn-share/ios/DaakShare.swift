import Foundation
import React
import UIKit

private let kDarwinShareInboxChanged = "dev.darshit.daak.share.inbox.changed"

@objc(DaakShare)
class DaakShare: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { true }

  /// The share extension posts this Darwin notification when it has staged
  /// something. All this observer does is record that the inbox moved, so a
  /// later drain knows to look; handing the drained items to the engine is
  /// Tasks 7/9/11's job, not this task's.
  private var inboxDirty = false

  /// True once the extension has signalled a staging. Read by the drain; the
  /// consumer that turns drained items into engine work lands in Tasks 7/9/11.
  @objc var hasPendingInbox: Bool {
    get { inboxDirty }
    set { inboxDirty = newValue }
  }

  override init() {
    super.init()
    CFNotificationCenterAddObserver(
      CFNotificationCenterGetDarwinNotifyCenter(),
      Unmanaged.passUnretained(self).toOpaque(),
      { _, observer, _, _, _ in
        guard observer != nil else { return }
        let me = Unmanaged<DaakShare>.fromOpaque(observer!).takeUnretainedValue()
        me.inboxDirty = true
      },
      kDarwinShareInboxChanged as CFString, nil, .deliverImmediately)
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
      if allFilesMoved { try? fm.removeItem(at: batch) }
    }
    let json = (try? JSONSerialization.data(withJSONObject: merged)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
    resolve(json)
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
