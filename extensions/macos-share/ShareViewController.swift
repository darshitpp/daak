import Cocoa
import UniformTypeIdentifiers

// Staging only. The extension NEVER does crypto and NEVER talks to a peer: it
// writes bytes/text into the App Group inbox and wakes the host, which drains
// the inbox through the engine. Same contract as the iOS extension
// (apps/mobile/ios/DaakShareExtension/ShareViewController.swift) and the same
// staged layout, so one drain rule serves both platforms.
private let kDarwinInboxChanged = "dev.darshit.daak.inbox.changed"
private let kAppGroup = "group.dev.darshit.daak"
private let kInboxDir = "share-inbox"
private let kBatchDir = "batches"

// NSExtensionRequestHandling, NOT `viewDidAppear`. `beginRequestWithExtension-
// Context:` is delivered exactly once per extension request and is documented
// to arrive before -loadView; `viewDidAppear` is a UIKit-era hook whose AppKit
// signature takes no argument and which can fire again for a re-shown view.
// The plan's `override func viewDidAppear()` compiles (NSViewController.h:115
// declares `- (void)viewDidAppear`) but runs a share more than once if the view
// is ever re-ordered in, which would stage every payload twice.
// NSViewController ALREADY declares <NSExtensionRequestHandling> in the
// NSExtensionAdditions category (NSViewController.h:256), so the conformance is
// not re-listed here -- writing it is a compile error ("redundant conformance").
// What matters is that beginRequest(with:) is OVERRIDDEN, because the category's
// default implementation is a no-op.
// NO @objc(ShareViewController) rename. Info.plist resolves the principal class
// as $(PRODUCT_MODULE_NAME).ShareViewController, and a Swift class's ObjC
// runtime name is mangled to _TtC<module><len><class> -- Apple's own shipped
// SimulatorShareExtension.appex has exactly that symbol and its plist says
// "SimulatorShareExtension.ShareViewController". An @objc rename to the bare
// name would make the plist lookup miss, and the extension would never load.
final class ShareViewController: NSViewController {
  override func beginRequest(with context: NSExtensionContext) {
    super.beginRequest(with: context)
    Task { await ingest(context) }
  }

  private func ingest(_ context: NSExtensionContext) async {
    // No container, no share. Force-unwrapping here would crash an unsigned or
    // locally-provisioned build, where the App Group is not provisioned -- and
    // the iOS extension deliberately guards instead.
    guard let container = FileManager.default
      .containerURL(forSecurityApplicationGroupIdentifier: kAppGroup)
    else { return finish(context) }
    let inbox = container.appendingPathComponent(kInboxDir, isDirectory: true)
    do { try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true) }
    catch { return finish(context) }

    var items: [[String: String]] = []
    for case let input as NSExtensionItem in context.inputItems {
      // EVERY attachment, not just the first. A Finder multi-select is ONE
      // NSExtensionItem carrying N attachments; taking attachments.first would
      // stage one file, report success, and lose the other N-1 with no error --
      // and this extension's own Info.plist sets
      // NSExtensionActivationSupportsFileWithMaxCount=50, so multi-file is the
      // EXPECTED case, not an edge case. The iOS extension loops the same way.
      for provider in input.attachments ?? [] {
        // File FIRST, text as the fallback. The ORDER carries the intent, not a
        // type predicate: public.item is the ROOT type, so every conforming
        // provider passes a public.item gate -- measured YES for a file
        // representation on public.plain-text, on public.png, for
        // contentsOf(url), for a file-url provider, and even for a data-only
        // plain-text provider. A gate on public.file-url, by contrast, is NO for
        // the first two (a Finder provider registers under the CONCRETE UTI),
        // which is how a shared document ends up sent as a string. loadFile-
        // Representation(public.item) returns the real bytes in all of those
        // shapes, so try it first and never gate on it.
        if let item = try? await copyFile(provider, into: inbox) {
          items.append(item)
        } else if let item = try? await stageText(provider, into: inbox) {
          // A failed file load must not discard the share silently: the user
          // hands over a file and Daak reports nothing happened.
          items.append(item)
        }
      }
    }

    // Nothing staged means nothing to ingest. The plan posts the Darwin
    // notification unconditionally, which wakes the host for an empty inbox --
    // the exact "a file was shared" claim the iOS extension refuses to make.
    guard !items.isEmpty else { return finish(context) }

    // Batches live in their own subdir, never beside the staged payload files.
    // A suffix filter is not enough: a shared "report.batch" is staged as
    // "<uuid>-report.batch" and would still be read as a batch. A directory
    // cannot collide, and the drain scans it NON-recursively.
    let batchDir = inbox.appendingPathComponent(kBatchDir, isDirectory: true)
    do { try FileManager.default.createDirectory(at: batchDir, withIntermediateDirectories: true) }
    catch { return finish(context) }
    let batch = batchDir.appendingPathComponent(UUID().uuidString + ".json")
    // Metadata write failed: no notify and no claimed success. The staged
    // files are not lost -- the drain scans the inbox top level
    // non-recursively, so it still picks them up; only the batch grouping is
    // missing.
    guard let data = try? JSONSerialization.data(withJSONObject: items),
          (try? data.write(to: batch, options: .atomic)) != nil
    else { return finish(context) }
    notifyHost()
    finish(context)
  }

  // Text is written to the inbox as a .txt file, NOT carried in the batch
  // manifest as a "kind": "text" string. ingestInbox scans the inbox for
  // REGULAR FILES and sends one engine.send per file; a manifest-only text item
  // is invisible to that drain, so a shared note would be staged, announced,
  // and never sent. Writing it as a file is also what the plan did, and it is
  // the only shape both the batch manifest and the drain agree on.
  private func stageText(_ provider: NSItemProvider, into inbox: URL) async throws -> [String: String] {
    try await withCheckedThrowingContinuation { cont in
      provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) { item, error in
        if let error { cont.resume(throwing: error); return }
        // The plan casts to String only. A provider that hands back NSData (a
        // .txt from Notes, a dropped drag) would then be dropped silently, so
        // the user shares something and Daak says nothing happened.
        let text: String?
        if let s = item as? String { text = s }
        else if let d = item as? Data { text = String(data: d, encoding: .utf8) }
        else { text = nil }
        guard let text else {
          cont.resume(throwing: CocoaError(.fileReadCorruptFile)); return
        }
        let staged = "shared-text-\(UUID().uuidString).txt"
        do {
          try text.write(to: inbox.appendingPathComponent(staged), atomically: true, encoding: .utf8)
        } catch {
          cont.resume(throwing: error); return
        }
        cont.resume(returning: ["kind": "file", "path": staged, "name": staged,
                                "mime": UTType.plainText.preferredMIMEType ?? "text/plain"])
      }
    }
  }

  private func copyFile(_ provider: NSItemProvider, into inbox: URL) async throws -> [String: String] {
    // suggestedName is nil on EVERY provider shape measured (a file
    // representation on a concrete UTI, contentsOf(url), a file-url provider),
    // so the fallback is the normal case: a Finder multi-select of ten files
    // would stage ten files all named "payload" and the receiver could not tell
    // them apart. Fall back through the registered type instead.
    let hint = provider.suggestedName.map { ($0 as NSString).lastPathComponent }
    let typeExt = provider.registeredTypeIdentifiers
      .compactMap { UTType($0)?.preferredFilenameExtension }.first
    // loadFileRepresentation's URL is deleted the moment this callback returns
    // (NSItemProvider.h:118), so the copy MUST happen inside it. The plan's
    // loadItem(forTypeIdentifier: UTType.fileURL) + copyItem is a documented
    // footgun: the item is not guaranteed to be a URL at all, and the URL the
    // loadFileRepresentation form hands back is already a temp copy we own.
    return try await withCheckedThrowingContinuation {
      (cont: CheckedContinuation<[String: String], Error>) in
      provider.loadFileRepresentation(forTypeIdentifier: UTType.item.identifier) { url, error in
        if let error { cont.resume(throwing: error); return }
        guard let url else { cont.resume(throwing: CocoaError(.fileNoSuchFile)); return }
        do {
          // Copy the bytes the provider HANDED OVER, always. An earlier
          // revision detected a "file://" prefix in the loaded file and
          // substituted the referenced path instead. Measured: it fired on
          // every ordinary Finder provider, not just the file-url-only shape it
          // was written for, so sharing a small text file that happened to
          // contain a file:// URL silently shipped ANOTHER file's bytes under
          // that file's name and MIME, and the user's own share was discarded
          // with no visible signal. `isRegularFile` does not bound it to the App
          // Group either -- only the OS sandbox did, which is not a code-level
          // control. It also never fired for the shape it targeted when the
          // path had a space (URL(string:) does not decode %20), so it bought a
          // silent correctness bug for an unproven edge. Removed for good.
          let display = hint ?? ("payload" + (typeExt.map { "." + $0 } ?? ""))
          let staged = UUID().uuidString + "-" + display
          try FileManager.default.copyItem(at: url, to: inbox.appendingPathComponent(staged))
          var item = ["kind": "file", "path": staged, "name": display]
          if let mime = UTType(filenameExtension: (display as NSString).pathExtension)?.preferredMIMEType {
            item["mime"] = mime
          }
          cont.resume(returning: item)
        } catch {
          cont.resume(throwing: error)
        }
      }
    }
  }

  private func notifyHost() {
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(),
      CFNotificationName(kDarwinInboxChanged as CFString), nil, nil, true)
  }

  private func finish(_ context: NSExtensionContext) {
    context.completeRequest(returningItems: nil)
  }
}
