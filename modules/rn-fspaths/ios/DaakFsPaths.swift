import Foundation
import React
import UIKit
import QuickLook

/// Every path this module hands out is an APP-SANDBOX path. The engine's data
/// dir and every saved file live here, so a caller can never steer the engine
/// outside the sandbox by passing a dir in.
@objc(DaakFsPaths)
class DaakFsPaths: NSObject, UIDocumentPickerDelegate {
  private static let bookmarkKey = "daak.downloadFolder.bookmark"
  private static let nameKey = "daak.downloadFolder.name"
  /// The location AS TEXT, for the Settings row: a folder NAME alone does not
  /// say where the files are.
  private static let pathKey = "daak.downloadFolder.path"

  /// The pending picker promise. A UIDocumentPicker is presented and answered
  /// asynchronously, so the promise is held until the delegate fires -- and
  /// released on BOTH paths, or a cancelled picker leaves JS waiting forever.
  private var pendingChoose: RCTPromiseResolveBlock?
  private var previewSource: DaakPreviewSource?
  /// The navigation controller that holds the open preview, for the Done button.
  private weak var previewNav: UINavigationController?
  @objc static func requiresMainQueueSetup() -> Bool { false }

  /// The Done button of the file preview.
  @objc private func closePreview() {
    previewNav?.dismiss(animated: true)
  }

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

  /// Opens a received file in QuickLook, the iOS viewer for the file's type.
  ///
  /// A file that the user moved into the chosen download folder sits outside
  /// the sandbox. The bookmark scope must stay open while the preview shows, so
  /// DaakPreviewSource owns the scope and closes it when the preview goes away.
  /// Resolves false, never rejects, for a path the app cannot read.
  @objc func openFile(_ path: String,
                      resolve: @escaping RCTPromiseResolveBlock,
                      reject: @escaping RCTPromiseRejectBlock) {
    let scope = Self.chosenFolderScope()
    guard FileManager.default.isReadableFile(atPath: path) else {
      scope?.stopAccessingSecurityScopedResource()
      resolve(false)
      return
    }
    DispatchQueue.main.async {
      guard let root = UIApplication.shared.connectedScenes
        .compactMap({ ($0 as? UIWindowScene)?.keyWindow })
        .first?.rootViewController
      else {
        scope?.stopAccessingSecurityScopedResource()
        resolve(false)
        return
      }
      var top = root
      while let next = top.presentedViewController { top = next }
      let source = DaakPreviewSource(url: URL(fileURLWithPath: path), scope: scope)
      self.previewSource = source
      let preview = QLPreviewController()
      preview.dataSource = source
      // The preview is presented over the app's root, with no sure way out.
      // An explicit Done in a navigation bar is the way back.
      preview.navigationItem.leftBarButtonItem = UIBarButtonItem(
        barButtonSystemItem: .done,
        target: self,
        action: #selector(self.closePreview))
      let nav = UINavigationController(rootViewController: preview)
      nav.modalPresentationStyle = .fullScreen
      self.previewNav = nav
      top.present(nav, animated: true) { resolve(true) }
    }
  }

  /// Starts the security scope of the remembered download folder, or nil when
  /// none is set. The caller must stop the scope that this returns.
  private static func chosenFolderScope() -> URL? {
    guard let bookmark = UserDefaults.standard.data(forKey: bookmarkKey) else { return nil }
    var stale = false
    guard let folder = try? URL(
      resolvingBookmarkData: bookmark, options: [], relativeTo: nil,
      bookmarkDataIsStale: &stale),
      folder.startAccessingSecurityScopedResource()
    else { return nil }
    return folder
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

  /// The size of each path, in order. `NSNull` marks an unknown size: a missing
  /// file, an unreadable file, or a directory. A Swift `nil` cannot go in the
  /// array, so `NSNull` is the bridge value for null.
  @objc func fileSizes(_ paths: [String],
                       resolve: @escaping RCTPromiseResolveBlock,
                       reject: @escaping RCTPromiseRejectBlock) {
    let fm = FileManager.default
    let sizes: [Any] = paths.map { (path: String) -> Any in
      guard let attrs = try? fm.attributesOfItem(atPath: path),
            attrs[.type] as? FileAttributeType == .typeRegular,
            let size = attrs[.size] as? NSNumber else { return NSNull() }
      return size
    }
    resolve(sizes)
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

  /// R42p: ask for a destination folder with a document picker in FOLDER mode.
  ///
  /// The picker gives a URL outside the sandbox, so the BOOKMARK is what is
  /// stored: a bare path to a folder this app does not own stops resolving, the
  /// same rule the macOS half records. The name is kept beside it only so the
  /// Settings row can show the choice without resolving anything.
  @objc func chooseDownloadFolder(_ resolve: @escaping RCTPromiseResolveBlock,
                                   reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      guard let root = UIApplication.shared.connectedScenes
        .compactMap({ ($0 as? UIWindowScene)?.keyWindow })
        .first?.rootViewController
      else {
        // No window to present from: nothing can be shown, so nothing changed.
        resolve(nil)
        return
      }
      self.pendingChoose = resolve
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
      picker.delegate = self
      picker.allowsMultipleSelection = false
      root.present(picker, animated: true)
    }
  }

  func documentPicker(_ controller: UIDocumentPickerViewController,
                      didPickDocumentsAt urls: [URL]) {
    guard let resolve = pendingChoose, let url = urls.first else {
      pendingChoose?(nil)
      pendingChoose = nil
      return
    }
    pendingChoose = nil
    // The picked URL is security scoped. The scope must be OPEN while the
    // bookmark is made, or the bookmark does not carry the access and every
    // later move out of the app sandbox is refused (field test 2026-10-11:
    // the picker worked and received files still stayed in the app folder).
    let opened = url.startAccessingSecurityScopedResource()
    defer { if opened { url.stopAccessingSecurityScopedResource() } }
    do {
      let bookmark = try url.bookmarkData(
        options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
      let defaults = UserDefaults.standard
      defaults.set(bookmark, forKey: Self.bookmarkKey)
      defaults.set(url.lastPathComponent, forKey: Self.nameKey)
      defaults.set(url.path, forKey: Self.pathKey)
      resolve(url.path)
    } catch {
      NSLog("Daak: the download folder bookmark could not be made: \(error)")
      resolve(nil)
    }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    // A cancelled picker is an ANSWER, not an error: nothing changed.
    pendingChoose?(nil)
    pendingChoose = nil
  }

  @objc func downloadFolderName(_ resolve: @escaping RCTPromiseResolveBlock,
                                reject: @escaping RCTPromiseRejectBlock) {
    let defaults = UserDefaults.standard
    resolve(defaults.string(forKey: Self.pathKey) ?? defaults.string(forKey: Self.nameKey))
  }

  @objc func clearDownloadFolder(_ resolve: @escaping RCTPromiseResolveBlock,
                                 reject: @escaping RCTPromiseRejectBlock) {
    let defaults = UserDefaults.standard
    defaults.removeObject(forKey: Self.bookmarkKey)
    defaults.removeObject(forKey: Self.nameKey)
    defaults.removeObject(forKey: Self.pathKey)
    resolve(nil)
  }

  /// MOVE each received file into the remembered folder, one answer per input.
  ///
  /// A MOVE, not a copy: the engine's copy is the same bytes, so keeping it
  /// would store every file twice with one of the two invisible. A file that
  /// cannot be moved keeps its ORIGINAL path, and an unset folder returns the
  /// input unchanged -- which is what makes the feature degrade to the old
  /// behavior rather than failing.
  @objc func moveReceivedFiles(_ paths: [String],
                               resolve: @escaping RCTPromiseResolveBlock,
                               reject: @escaping RCTPromiseRejectBlock) {
    guard let bookmark = UserDefaults.standard.data(forKey: Self.bookmarkKey) else {
      resolve(paths)
      return
    }
    var stale = false
    guard let folder = try? URL(
      resolvingBookmarkData: bookmark, options: [], relativeTo: nil,
      bookmarkDataIsStale: &stale)
    else {
      NSLog("Daak: the download folder bookmark did not resolve; files stay in the app folder")
      resolve(paths)
      return
    }
    let scoped = folder.startAccessingSecurityScopedResource()
    defer { if scoped { folder.stopAccessingSecurityScopedResource() } }
    if !scoped {
      NSLog("Daak: the download folder scope did not open (stale bookmark: \(stale)); the move may be refused")
    }

    let fm = FileManager.default
    var out: [String] = []
    for path in paths {
      let src = URL(fileURLWithPath: path)
      var dest = folder.appendingPathComponent(src.lastPathComponent)
      // Never overwrite: two files called photo.jpg are two files.
      var n = 1
      while fm.fileExists(atPath: dest.path) {
        let base = src.deletingPathExtension().lastPathComponent
        let ext = src.pathExtension
        let name = ext.isEmpty ? "\(base)-\(n)" : "\(base)-\(n).\(ext)"
        dest = folder.appendingPathComponent(name)
        n += 1
      }
      do {
        try Self.place(src, at: dest, fm: fm)
        out.append(dest.path)
      } catch {
        // The file stays where it is. The log says why, because a silent
        // fallback looks like a feature that does nothing.
        NSLog("Daak: could not move \(src.lastPathComponent) into the download folder: \(error)")
        out.append(path)
      }
    }
    resolve(out)
  }

  // Task 6 replaces these bodies. The stubs keep the Spec and the .mm table in step.
  @objc func saveToLibrary(_ paths: [String],
                           resolve: @escaping RCTPromiseResolveBlock,
                           reject: @escaping RCTPromiseRejectBlock) {
    resolve(paths)
  }

  @objc func requestPhotosAccess(_ resolve: @escaping RCTPromiseResolveBlock,
                                 reject: @escaping RCTPromiseRejectBlock) {
    resolve(false)
  }

  @objc func photosAccessStatus(_ resolve: @escaping RCTPromiseResolveBlock,
                                reject: @escaping RCTPromiseRejectBlock) {
    resolve("unavailable")
  }

  /// Put one file at `dest`. A plain move is the first try. A folder served by
  /// a File Provider (iCloud Drive, another app's folder) can refuse it, so the
  /// second try is a COORDINATED copy, and the source is removed only after the
  /// copy succeeded.
  private static func place(_ src: URL, at dest: URL, fm: FileManager) throws {
    do {
      try fm.moveItem(at: src, to: dest)
      return
    } catch {
      NSLog("Daak: a plain move was refused (\(error)); trying a coordinated copy")
    }
    var coordinationError: NSError?
    var copyError: Error?
    NSFileCoordinator(filePresenter: nil).coordinate(
      writingItemAt: dest, options: .forReplacing, error: &coordinationError
    ) { target in
      do { try fm.copyItem(at: src, to: target) } catch { copyError = error }
    }
    if let failure = coordinationError ?? copyError { throw failure }
    try? fm.removeItem(at: src)
  }
}

/// The QuickLook data source for one file. It holds the bookmark scope of the
/// download folder, so a file outside the sandbox stays readable until the
/// preview is dismissed and this object is released.
final class DaakPreviewSource: NSObject, QLPreviewControllerDataSource {
  private let url: URL
  private let scope: URL?

  init(url: URL, scope: URL?) {
    self.url = url
    self.scope = scope
  }

  deinit { scope?.stopAccessingSecurityScopedResource() }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

  func previewController(_ controller: QLPreviewController,
                         previewItemAt index: Int) -> QLPreviewItem {
    url as NSURL
  }
}

