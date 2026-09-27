import UIKit
import UniformTypeIdentifiers

// Staging only. The extension NEVER does crypto and NEVER talks to a peer: it
// writes bytes/text into the App Group inbox and wakes the host. The Rust engine
// encrypts and sends from the host side.
private let kDarwinShareInboxChanged = "dev.darshit.daak.share.inbox.changed"
private let kAppGroup = "group.dev.darshit.daak"
private let kInboxDir = "share-inbox"
private let kBatchDir = "batches"

final class ShareViewController: UIViewController {
  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    Task { await ingest() }
  }

  private func ingest() async {
    guard let ext = extensionContext,
          let container = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: kAppGroup)
    else { return finish() }
    let inbox = container.appendingPathComponent(kInboxDir, isDirectory: true)
    // No inbox, no share. Falling through would write an empty batch and tell
    // the user a file was shared when nothing was staged anywhere.
    do {
      try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
    } catch {
      return finish()
    }

    var items: [[String: String]] = []
    for input in ext.inputItems {
      guard let provider = input as? NSItemProvider else { continue }
      // File BEFORE text: an image or document from Photos/Files also
      // advertises a text-ish type on some OS versions and would be captured as
      // a string instead of as a file.
      if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
        if let item = try? await copyFile(provider, into: inbox) { items.append(item) }
      } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
        if let text = try? await loadText(provider) { items.append(["kind": "text", "text": text]) }
      }
    }

    // Batches live in their own subdir, never beside the staged payload files. A
    // suffix filter is not enough: a shared file called "report.batch" would be
    // staged as "<uuid>-report.batch" and still be read as a batch. A directory
    // cannot collide, and the drain scans it NON-recursively.
    let batchDir = inbox.appendingPathComponent(kBatchDir, isDirectory: true)
    do { try FileManager.default.createDirectory(at: batchDir, withIntermediateDirectories: true) }
    catch { return finish() }
    let batch = batchDir.appendingPathComponent(UUID().uuidString + ".json")
    // Staging failed: the copied bytes would be orphans nobody can find, so do
    // NOT notify and do not claim success. Just close the sheet.
    guard let data = try? JSONSerialization.data(withJSONObject: items),
          (try? data.write(to: batch, options: .atomic)) != nil
    else { return finish() }
    notifyHost()
    finish()
  }

  private func loadText(_ provider: NSItemProvider) async throws -> String {
    try await withCheckedThrowingContinuation { cont in
      provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) { item, error in
        if let error { cont.resume(throwing: error); return }
        if let s = item as? String { cont.resume(returning: s); return }
        if let d = item as? Data, let s = String(data: d, encoding: .utf8) {
          cont.resume(returning: s); return
        }
        // Unknown representation: skip the item rather than stage an empty text
        // send the user never made.
        cont.resume(throwing: CocoaError(.fileReadCorruptFile))
      }
    }
  }

  private func copyFile(_ provider: NSItemProvider, into inbox: URL) async throws -> [String: String] {
    let display = provider.suggestedName.map { ($0 as NSString).lastPathComponent } ?? "payload"
    let staged = UUID().uuidString + "-" + display
    let dest = inbox.appendingPathComponent(staged)
    // loadFileRepresentation's URL is deleted the moment this callback returns,
    // so the copy MUST happen inside it (this is the whole reason the call is
    // not awaited-then-copied).
    let copied = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Bool, Error>) in
      provider.loadFileRepresentation(forTypeIdentifier: UTType.item.identifier) { url, error in
        if let error { cont.resume(throwing: error); return }
        guard let url, (try? FileManager.default.copyItem(at: url, to: dest)) != nil else {
          // No URL, or the copy failed: do NOT report a file that is not there.
          cont.resume(returning: false); return
        }
        cont.resume(returning: true)
      }
    }
    guard copied else { throw CocoaError(.fileWriteUnknown) }
    var item = ["kind": "file", "path": staged, "name": display]
    // Optional mime, resolved from the filename's extension. Optional on purpose:
    // a share with no extension simply omits the field (R7).
    if let mime = UTType(filenameExtension: (display as NSString).pathExtension)?.preferredMIMEType {
      item["mime"] = mime
    }
    return item
  }

  private func notifyHost() {
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(),
      CFNotificationName(kDarwinShareInboxChanged as CFString), nil, nil, true)
  }

  private func finish() {
    extensionContext?.completeRequest(returningItems: nil)
  }
}
