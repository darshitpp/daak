import Foundation
import React
import UIKit

@objc(DaakShare)
class DaakShare: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { true }

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
    let batches = ((try? fm.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil)) ?? [])
      .filter { $0.pathExtension == "json" }
    var merged: [[String: String]] = []
    for batch in batches {
      // Delete ONLY after a successful parse: a batch we cannot read holds the
      // only copy of the user's files, so it stays put for a later drain.
      guard let data = try? Data(contentsOf: batch),
            let arr = (try? JSONSerialization.jsonObject(with: data)) as? [[String: String]]
      else { continue }
      for var item in arr {
        if item["kind"] == "file", let rel = item["path"],
           let docs = try? fm.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true) {
          let src = inbox.appendingPathComponent(rel)
          let dest = docs.appendingPathComponent(rel)
          // moveItem fails when dest already exists, so replace in that case
          // rather than stranding the staged bytes.
          let moved = fm.fileExists(atPath: dest.path)
            ? ((try? fm.replaceItemAt(dest, withItemAt: src)) != nil)
            : ((try? fm.moveItem(at: src, to: dest)) != nil)
          if moved { item["path"] = dest.path }
          // A failed move leaves item["path"] at the staged file, which still
          // exists in the App Group and is still readable by the host.
        }
        merged.append(item)
      }
      try? fm.removeItem(at: batch)
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
