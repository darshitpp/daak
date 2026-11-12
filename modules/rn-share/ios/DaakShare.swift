import Foundation
import Photos
import PhotosUI
import React
import UIKit
import UniformTypeIdentifiers

private let kDarwinShareInboxChanged = "dev.darshit.daak.share.inbox.changed"

@objc(DaakShare)
class DaakShare: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { true }

  /// The maximum number of items in one media pick. Android has the same cap.
  static let maxMedia = 5000
  /// The free space that materialize keeps above the size of one item.
  /// A NO_SPACE code holds the size plus this margin. Android adds the same margin.
  static let mediaMargin: Int64 = 16 * 1024 * 1024
  /// The maximum UTF-8 length of a cleaned file name. Android has the same cap.
  static let maxLeafBytes = 200
  /// The maximum length of an extension that safeLeaf keeps when it cuts a name.
  static let maxExtChars = 16

  /// The item provider of each picked item in this process, keyed by token.
  /// It holds the items of each pick in this process. A success does not
  /// remove a provider. So a second materialize of the same token does not go
  /// to the asset path, which can show the Photos prompt. A provider is small.
  /// mediaLock guards it.
  private var mediaProviders: [String: NSItemProvider] = [:]
  private let mediaLock = NSLock()
  /// The promise of the open media pick. Main thread only.
  private var mediaResolve: RCTPromiseResolveBlock?
  private var mediaReject: RCTPromiseRejectBlock?
  /// The picker of the open media pick. Main thread only. It is weak, so a
  /// picker that closed without a delegate call becomes nil.
  private weak var mediaPicker: PHPickerViewController?

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
    // Assigning the delegate is the WHOLE contract. It was retained with
    // objc_setAssociatedObject and never assigned, so no callback ever fired:
    // the promise never settled, the Send screen never received a file, and its
    // button stayed disabled. Retaining is not assigning.
    picker.delegate = delegate
    objc_setAssociatedObject(picker, &documentPickerDelegateKey, delegate, .OBJC_ASSOCIATION_RETAIN)
    DispatchQueue.main.async {
      guard let root = Self.rootViewController() else {
        reject("E_NO_VC", "no root view controller", nil); return
      }
      root.present(picker, animated: true)
    }
  }

  /// Ask for one folder, then copy its tree into
  /// `<caches>/daak-send/<uuid>/<folder name>`. Resolves the absolute path of
  /// the copy, or nil on cancel. The picked folder is outside the sandbox and
  /// its security scope closes, so the engine sends from the copy.
  /// Rejects `NO_SPACE:<needed bytes>` or `EMPTY`.
  @objc func pickFolder(_ resolve: @escaping RCTPromiseResolveBlock,
                        reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      guard let root = Self.rootViewController() else {
        reject("E_NO_VC", "no root view controller", nil); return
      }
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
      picker.allowsMultipleSelection = false
      let delegate = FolderPickerDelegate(resolve: resolve, reject: reject)
      picker.delegate = delegate
      // The picker holds its delegate weakly. The picker keeps this one alive.
      objc_setAssociatedObject(picker, &folderPickerDelegateKey, delegate, .OBJC_ASSOCIATION_RETAIN)
      root.present(picker, animated: true)
    }
  }

  /// Ask for photos and videos. Resolves the JSON text of
  /// `[{ token, name, size }]`. The pick copies no bytes. A cancel gives `[]`.
  /// Rejects `E_PICK_BUSY` when a pick is open, and `E_TOO_MANY` for more than
  /// maxMedia items. The pick does not ask for Photos access.
  @objc func pickMedia(_ resolve: @escaping RCTPromiseResolveBlock,
                       reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      if self.mediaResolve != nil {
        // A picker on the screen: the new call rejects. The open pick keeps its promise.
        let open = self.mediaPicker.map { $0.presentingViewController != nil || $0.isBeingPresented } ?? false
        if open {
          reject("E_PICK_BUSY", "a pick is open", nil); return
        }
        // The old picker closed without a delegate call. A sheet under it
        // can close it, or UIKit can refuse the presentation. The old promise
        // gets an empty pick, and the new call continues.
        self.mediaResolve?("[]")
        self.mediaResolve = nil
        self.mediaReject = nil
        self.mediaPicker = nil
      }
      guard let root = Self.rootViewController() else {
        reject("E_NO_VC", "no root view controller", nil); return
      }
      var config = PHPickerConfiguration(photoLibrary: .shared())
      config.filter = .any(of: [.images, .videos])
      config.selectionLimit = 0
      // .current gives the original bytes. .compatible transcodes (device test
      // 2026-11-11: HEIC became JPEG and the videos changed).
      config.preferredAssetRepresentationMode = .current
      let picker = PHPickerViewController(configuration: config)
      picker.delegate = self
      // A swipe must not close the sheet. The delegate must get each close,
      // or the busy state stays set.
      picker.isModalInPresentation = true
      // Present from the top sheet. A root with an open sheet presents
      // nothing, and then the busy state stays set.
      var top = root
      while let next = top.presentedViewController { top = next }
      self.mediaResolve = resolve
      self.mediaReject = reject
      self.mediaPicker = picker
      // UIKit can refuse the presentation in silence, for example during a
      // dismiss transition. Then this call rejects. When UIKit does not run
      // this completion, the busy check of the next call frees the state.
      top.present(picker, animated: true) {
        // mediaPicker === picker: the state still belongs to this call.
        guard picker.presentingViewController == nil, self.mediaPicker === picker,
              self.mediaReject != nil else { return }
        self.mediaResolve = nil
        self.mediaReject = nil
        self.mediaPicker = nil
        reject("E_PICK", "the media picker did not open", nil)
      }
    }
  }

  /// Copy ONE picked item into `<caches>/daak-send/<uuid>/<cleaned name>` and
  /// resolve the absolute path of the copy. Rejects `NO_SPACE:<needed bytes>`,
  /// `E_SOURCE_GONE`, `NOT_DOWNLOADED`, or `E_MATERIALIZE`. No reject message
  /// holds a name, a token, or a path.
  @objc func materialize(_ token: String,
                         resolve: @escaping RCTPromiseResolveBlock,
                         reject: @escaping RCTPromiseRejectBlock) {
    // The copy can take minutes. It must not block the main thread.
    DispatchQueue.global(qos: .userInitiated).async {
      self.mediaLock.lock()
      let provider = self.mediaProviders[token]
      self.mediaLock.unlock()
      if let provider {
        self.materializeProvider(token, provider, resolve: resolve, reject: reject)
      } else if token.hasPrefix("provider:") {
        // A provider token has no asset. It cannot come back after a restart.
        MediaFailure.sourceGone.reject(reject)
      } else {
        self.materializeAsset(token, resolve: resolve, reject: reject)
      }
    }
  }

  /// Copy an item of a pick in this process. This needs no Photos access.
  private func materializeProvider(_ token: String, _ provider: NSItemProvider,
                                   resolve: @escaping RCTPromiseResolveBlock,
                                   reject: @escaping RCTPromiseRejectBlock) {
    guard let type = Self.mediaType(provider) else {
      MediaFailure.failed.reject(reject); return
    }
    let name = Self.mediaName(provider)
    let slot = DaakShare.newSendSlot()
    provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
      let fm = FileManager.default
      // A load error or a nil URL is an iCloud item that did not download.
      // A full disk during the system temp copy gives NO_SPACE.
      guard let url, error == nil else {
        try? fm.removeItem(at: slot)
        let failure = error.map { MediaFailure.from($0, size: nil, other: .notDownloaded) } ?? .notDownloaded
        failure.reject(reject); return
      }
      // The system deletes the temp file when this handler returns. So the
      // move must be here.
      let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize.map { Int64($0) }
      let dest = slot.appendingPathComponent(name)
      do {
        try fm.createDirectory(at: slot, withIntermediateDirectories: true)
        do {
          try fm.moveItem(at: url, to: dest)
        } catch {
          try fm.copyItem(at: url, to: dest)
        }
      } catch {
        try? fm.removeItem(at: slot)
        MediaFailure.from(error, size: size, other: .failed).reject(reject); return
      }
      // The provider stays in mediaProviders. A later load of it works,
      // because loadFileRepresentation makes a new temp copy each time.
      resolve(dest.path)
    }
  }

  /// Copy an asset of a restored plan. Only this path asks for Photos access.
  /// Under limited access an asset outside the selection does not resolve.
  private func materializeAsset(_ token: String,
                                resolve: @escaping RCTPromiseResolveBlock,
                                reject: @escaping RCTPromiseRejectBlock) {
    var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    if status == .notDetermined {
      // This runs on a background queue, so the wait does not block the UI.
      let done = DispatchSemaphore(value: 0)
      PHPhotoLibrary.requestAuthorization(for: .readWrite) { _ in done.signal() }
      done.wait()
      status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    }
    guard status == .authorized || status == .limited else {
      MediaFailure.sourceGone.reject(reject); return
    }
    guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [token], options: nil).firstObject,
          let resource = Self.originalResource(asset) else {
      MediaFailure.sourceGone.reject(reject); return
    }
    let size = Self.resourceSize(resource)
    let fm = FileManager.default
    let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    let free = (try? caches.resourceValues(
      forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?
      .volumeAvailableCapacityForImportantUsage
    // An unknown size or free space is not a refusal. A full disk fails the write.
    if let size, let free, free < size + Self.mediaMargin {
      MediaFailure.noSpace(size + Self.mediaMargin).reject(reject); return
    }
    let slot = DaakShare.newSendSlot()
    let dest = slot.appendingPathComponent(Self.safeLeaf(resource.originalFilename))
    do {
      try fm.createDirectory(at: slot, withIntermediateDirectories: true)
    } catch {
      try? fm.removeItem(at: slot)
      MediaFailure.from(error, size: size, other: .failed).reject(reject); return
    }
    let options = PHAssetResourceRequestOptions()
    // The original can be in iCloud only. The download is part of the write.
    options.isNetworkAccessAllowed = true
    PHAssetResourceManager.default().writeData(for: resource, toFile: dest, options: options) { error in
      if let error {
        try? fm.removeItem(at: slot)
        MediaFailure.from(error, size: size, other: .notDownloaded).reject(reject); return
      }
      resolve(dest.path)
    }
  }

  /// Describe the picked items as JSON text. This reads no file bytes and
  /// does not ask for Photos access.
  private func describeMedia(_ results: [PHPickerResult]) -> String? {
    let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    var assets: [String: PHAsset] = [:]
    if status == .authorized || status == .limited {
      let ids = results.compactMap { $0.assetIdentifier }
      PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
        .enumerateObjects { asset, _, _ in assets[asset.localIdentifier] = asset }
    }
    var items: [[String: Any]] = []
    var found: [String: NSItemProvider] = [:]
    for r in results {
      let token = r.assetIdentifier ?? "provider:" + UUID().uuidString
      found[token] = r.itemProvider
      var size: Any = NSNull()
      if let asset = assets[token], let resource = Self.originalResource(asset),
         let n = Self.resourceSize(resource) {
        size = n
      }
      items.append(["token": token, "name": Self.mediaName(r.itemProvider), "size": size])
    }
    mediaLock.lock()
    mediaProviders.merge(found) { _, new in new }
    mediaLock.unlock()
    guard let data = try? JSONSerialization.data(withJSONObject: items) else { return nil }
    return String(data: data, encoding: .utf8)
  }

  /// A new slot `<caches>/daak-send/<uuid>`. The caller makes the folder.
  /// DaakFsPaths sweeps and discards under the same root.
  static func newSendSlot() -> URL {
    FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("daak-send", isDirectory: true)
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
  }

  /// The first registered type that is an image or a movie.
  static func mediaType(_ provider: NSItemProvider) -> String? {
    provider.registeredTypeIdentifiers.first { id in
      guard let type = UTType(id) else { return false }
      return type.conforms(to: .image) || type.conforms(to: .movie)
    }
  }

  /// The suggested name plus the extension of the media type, cleaned.
  static func mediaName(_ provider: NSItemProvider) -> String {
    let base = provider.suggestedName ?? "media"
    guard let type = mediaType(provider),
          let ext = UTType(type)?.preferredFilenameExtension,
          (base as NSString).pathExtension.lowercased() != ext.lowercased()
    else { return safeLeaf(base) }
    return safeLeaf(base + "." + ext)
  }

  /// The current photo or video of an asset. An edited asset has a full size
  /// render, and the provider path with .current sends that render. So the
  /// render comes first. An unedited asset has only .photo or .video.
  static func originalResource(_ asset: PHAsset) -> PHAssetResource? {
    let all = PHAssetResource.assetResources(for: asset)
    let order: [PHAssetResourceType] = [.fullSizePhoto, .fullSizeVideo, .photo, .video]
    for type in order {
      if let found = all.first(where: { $0.type == type }) { return found }
    }
    return nil
  }

  /// The size of the file, or nil. A size of 0 gives nil, so the plan counts
  /// its default size. `fileSize` is not a documented
  /// key. value(forKey:) raises an Objective-C exception for an unknown key,
  /// and Swift cannot catch it. So the getter is checked first.
  static func resourceSize(_ resource: PHAssetResource) -> Int64? {
    guard resource.responds(to: NSSelectorFromString("fileSize")) else { return nil }
    return ((resource.value(forKey: "fileSize") as? NSNumber)?.int64Value).flatMap { $0 > 0 ? $0 : nil }
  }

  /// Clean one file name. The rule is the same as Android ShareInbox.safeLeaf:
  /// keep the last path part, replace control characters and `/:*?"<>|\` with
  /// `_`, and cut to maxLeafBytes of UTF-8. A short extension stays. An empty
  /// result gives `media`.
  static func safeLeaf(_ name: String) -> String {
    let leaf = name.split(separator: "/", omittingEmptySubsequences: false).last
      .map { $0.split(separator: "\\", omittingEmptySubsequences: false).last.map(String.init) ?? "" } ?? ""
    let bad = Set("/:*?\"<>|\\".unicodeScalars)
    var scalars = String.UnicodeScalarView()
    for s in leaf.unicodeScalars {
      scalars.append(s.value < 0x20 || bad.contains(s) ? "_" : s)
    }
    let cleaned = String(scalars).trimmingCharacters(in: .whitespacesAndNewlines)
    if cleaned.isEmpty || cleaned == "." || cleaned == ".." { return "media" }
    if cleaned.utf8.count <= maxLeafBytes { return cleaned }
    var ext = ""
    if let dot = cleaned.lastIndex(of: "."), dot > cleaned.startIndex {
      let candidate = String(cleaned[dot...])
      if candidate.count - 1 <= maxExtChars { ext = candidate }
    }
    let stem = cleaned.dropLast(ext.count)
    let budget = maxLeafBytes - ext.utf8.count
    var out = ""
    var used = 0
    for c in stem {
      let n = String(c).utf8.count
      if used + n > budget { break }
      out.append(c)
      used += n
    }
    return out + ext
  }

  /// iOS holds no URI grants for picked media, so nothing is released. The
  /// Spec is a shared contract, so the method must exist.
  @objc func releaseMedia(_ tokensJson: String,
                          resolve: @escaping RCTPromiseResolveBlock,
                          reject: @escaping RCTPromiseRejectBlock) {
    resolve(nil)
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

extension DaakShare: PHPickerViewControllerDelegate {
  /// The system calls this on the main thread for a pick and for a cancel.
  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    mediaPicker = nil
    guard let resolve = mediaResolve, let reject = mediaReject else { return }
    mediaResolve = nil
    mediaReject = nil
    if results.isEmpty { resolve("[]"); return }
    // A cut list sends fewer items than the user picked, in silence.
    if results.count > Self.maxMedia {
      reject("E_TOO_MANY", "too many items; pick fewer", nil); return
    }
    // The size lookup reads the Photos library. It must not block the main thread.
    DispatchQueue.global(qos: .userInitiated).async {
      if let json = self.describeMedia(results) {
        resolve(json)
      } else {
        reject("E_PICK", "the media selection could not be read", nil)
      }
    }
  }
}

/// Why a media materialize stopped. JS reads the reject code and message.
/// No message holds a name, a token, or a path.
enum MediaFailure: Error {
  case noSpace(Int64)
  case sourceGone
  case notDownloaded
  case failed

  /// A full disk gives noSpace with the item size plus mediaMargin, or 0 for
  /// an unknown size. Any other error gives `other`.
  static func from(_ error: Error, size: Int64?, other: MediaFailure) -> MediaFailure {
    let e = error as NSError
    let under = e.userInfo[NSUnderlyingErrorKey] as? NSError
    let full = (e.domain == NSCocoaErrorDomain && e.code == NSFileWriteOutOfSpaceError)
      || (e.domain == NSPOSIXErrorDomain && e.code == Int(ENOSPC))
      || (under?.domain == NSPOSIXErrorDomain && under?.code == Int(ENOSPC))
    return full ? .noSpace(size.map { $0 + DaakShare.mediaMargin } ?? 0) : other
  }

  func reject(_ reject: RCTPromiseRejectBlock) {
    switch self {
    case .noSpace(let needed): reject("NO_SPACE", "NO_SPACE:\(needed)", nil)
    case .sourceGone: reject("E_SOURCE_GONE", "E_SOURCE_GONE", nil)
    case .notDownloaded: reject("NOT_DOWNLOADED", "NOT_DOWNLOADED", nil)
    case .failed: reject("E_MATERIALIZE", "Daak could not prepare a file for sending.", nil)
    }
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

private var folderPickerDelegateKey: UInt8 = 0

/// Why a folder copy stopped. JS reads the reject message.
enum FolderCopyError: Error {
  case noSpace(Int64)
  case empty
  /// An iCloud Drive file in the tree is not on the device.
  case notDownloaded
}

final class FolderPickerDelegate: NSObject, UIDocumentPickerDelegate {
  let resolve: RCTPromiseResolveBlock
  let reject: RCTPromiseRejectBlock
  init(resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    self.resolve = resolve; self.reject = reject
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let folder = urls.first else { resolve(nil); return }
    let resolve = self.resolve
    let reject = self.reject
    // The copy can take minutes. It must not block the main thread.
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        resolve(try Self.copyPickedFolder(folder).path)
      } catch FolderCopyError.noSpace(let needed) {
        reject("NO_SPACE", "NO_SPACE:\(needed)", nil)
      } catch FolderCopyError.empty {
        reject("EMPTY", "EMPTY", nil)
      } catch FolderCopyError.notDownloaded {
        reject("NOT_DOWNLOADED", "NOT_DOWNLOADED", nil)
      } catch {
        NSLog("Daak: E_COPY: the picked folder could not be copied (\((error as NSError).domain) \((error as NSError).code))")
        reject("E_COPY", "the folder could not be copied", nil)
      }
    }
  }

  // Cancel starts no copy, so nothing is on disk to delete.
  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { resolve(nil) }

  /// One item of the picked tree. `parts` is the path below the picked folder.
  struct Entry {
    let src: URL
    let parts: [String]
    let isDir: Bool
    let size: Int64
  }

  /// Copy the tree below `folder` into a new slot in `<caches>/daak-send`.
  /// The copy is file by file with `copyItem`, which streams or clones on disk.
  /// No file goes into memory. Any failure deletes the slot.
  static func copyPickedFolder(_ folder: URL) throws -> URL {
    let opened = folder.startAccessingSecurityScopedResource()
    defer { if opened { folder.stopAccessingSecurityScopedResource() } }
    let fm = FileManager.default
    let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    let slot = DaakShare.newSendSlot()
    let dest = slot.appendingPathComponent(folder.lastPathComponent, isDirectory: true)
    do {
      var entries: [Entry] = []
      try listTree(folder, parts: [], into: &entries)
      let files = entries.filter { !$0.isDir }
      if files.isEmpty { throw FolderCopyError.empty }
      let total = files.reduce(Int64(0)) { $0 + $1.size }
      let needed = Int64((Double(total) * 1.1).rounded(.up))
      let free = (try? caches.resourceValues(
        forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?
        .volumeAvailableCapacityForImportantUsage
      // An unknown free space is not a refusal. A full disk fails the copy.
      if let free, free < needed { throw FolderCopyError.noSpace(needed) }
      try fm.createDirectory(at: dest, withIntermediateDirectories: true)
      // listTree puts each folder before its contents, so a parent exists.
      for entry in entries {
        let target = entry.parts.reduce(dest) { $0.appendingPathComponent($1) }
        if entry.isDir {
          try fm.createDirectory(at: target, withIntermediateDirectories: true)
        } else {
          try fm.copyItem(at: entry.src, to: target)
        }
      }
      return dest
    } catch {
      try? fm.removeItem(at: slot)
      throw error
    }
  }

  /// True for the hidden placeholder `.<name>.icloud` that iOS shows for an
  /// iCloud Drive file that is not on the device.
  static func isICloudPlaceholder(_ name: String) -> Bool {
    name.range(of: #"^\.(.+)\.icloud$"#, options: .regularExpression) != nil
  }

  /// List every folder and regular file below `dir`, hidden files included.
  /// A symlink is skipped, so the copy cannot leave the picked tree.
  /// An unreadable folder throws, so a copy never misses files in silence.
  /// An iCloud placeholder throws `notDownloaded`. A copy of it sends the
  /// placeholder and not the file. The listing runs before the first write,
  /// so this refusal leaves nothing on disk.
  static func listTree(_ dir: URL, parts: [String], into out: inout [Entry]) throws {
    let keys: Set<URLResourceKey> = [.isDirectoryKey, .isSymbolicLinkKey, .isRegularFileKey, .fileSizeKey]
    let children = try FileManager.default.contentsOfDirectory(
      at: dir, includingPropertiesForKeys: Array(keys), options: [])
    for child in children {
      if isICloudPlaceholder(child.lastPathComponent) { throw FolderCopyError.notDownloaded }
      let v = try child.resourceValues(forKeys: keys)
      if v.isSymbolicLink == true { continue }
      let p = parts + [child.lastPathComponent]
      if v.isDirectory == true {
        out.append(Entry(src: child, parts: p, isDir: true, size: 0))
        try listTree(child, parts: p, into: &out)
      } else if v.isRegularFile == true {
        out.append(Entry(src: child, parts: p, isDir: false, size: Int64(v.fileSize ?? 0)))
      }
    }
  }
}
