import AppKit
import Foundation
import React

/// Every path this module hands out is an APP-SANDBOX path, exactly as the iOS
/// half documents. The one exception is the folder the user CHOOSES, which is
/// outside the sandbox: it is reached through a security-scoped bookmark, and
/// never through a bare string that stops resolving after a relaunch.
@objc(DaakFsPaths)
class DaakFsPaths: NSObject {
  private static let bookmarkKey = "daak.downloadFolder.bookmark"
  private static let nameKey = "daak.downloadFolder.name"
  /// The location AS TEXT, for the Settings row. The bookmark is the
  /// permission; this is what the user is shown, and a folder NAME alone does
  /// not say where the files are.
  private static let pathKey = "daak.downloadFolder.path"

  @objc static func requiresMainQueueSetup() -> Bool { false }

  /// The engine's data dir, not the OS Documents dir: the database, the keys
  /// and every received file live under it.
  private static func dataDir() -> URL {
    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    return docs.appendingPathComponent("daak", isDirectory: true)
  }

  @objc func documentsDir(_ resolve: @escaping RCTPromiseResolveBlock,
                          reject: @escaping RCTPromiseRejectBlock) {
    resolve(Self.dataDir().path)
  }

  /// The engine's RECEIVE ROOT: `<data_dir>/downloads`, which is exactly the
  /// `dir.join("downloads")` out_dir daak-ffi's start() hands the engine.
  @objc func downloadsDir(_ resolve: @escaping RCTPromiseResolveBlock,
                          reject: @escaping RCTPromiseRejectBlock) {
    resolve(Self.dataDir().appendingPathComponent("downloads", isDirectory: true).path)
  }

  @objc func appGroupDir(_ resolve: @escaping RCTPromiseResolveBlock,
                         reject: @escaping RCTPromiseRejectBlock) {
    let container = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: "J6NNRLDUG4.group.dev.darshit.daak")
    // "" is an answer, not a failure: a relative path would be worse than none.
    resolve(container?.path ?? "")
  }

  /// REAL on macOS, unlike iOS: `activateFileViewerSelecting` opens Finder with
  /// the file selected. This is the verb the desktop Inbox was missing, which
  /// is why a received file could not be opened at all.
  @objc func reveal(_ path: String,
                    resolve: @escaping RCTPromiseResolveBlock,
                    reject: @escaping RCTPromiseRejectBlock) {
    let url = URL(fileURLWithPath: path)
    guard FileManager.default.fileExists(atPath: path) else { resolve(false); return }
    NSWorkspace.shared.activateFileViewerSelecting([url])
    resolve(true)
  }

  @objc func exists(_ path: String,
                    resolve: @escaping RCTPromiseResolveBlock,
                    reject: @escaping RCTPromiseRejectBlock) {
    resolve(FileManager.default.fileExists(atPath: path))
  }

  /// Ask for a folder and REMEMBER it.
  ///
  /// A sandboxed app cannot keep a path to a folder it does not own: the path
  /// stops resolving at the next launch. The bookmark is the permission, so the
  /// bookmark is what is stored. The name is stored beside it only so Settings
  /// can show the choice without resolving anything.
  @objc func chooseDownloadFolder(_ resolve: @escaping RCTPromiseResolveBlock,
                                  reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      let panel = NSOpenPanel()
      panel.canChooseFiles = false
      panel.canChooseDirectories = true
      panel.allowsMultipleSelection = false
      panel.canCreateDirectories = true
      panel.prompt = "Use this folder"
      panel.message = "Where should Daak keep the files you receive?"
      guard panel.runModal() == .OK, let url = panel.url else {
        // A cancelled panel is an ANSWER, not an error: nothing changed.
        resolve(nil)
        return
      }
      do {
        let bookmark = try url.bookmarkData(
          options: [.withSecurityScope],
          includingResourceValuesForKeys: nil,
          relativeTo: nil)
        let defaults = UserDefaults.standard
        defaults.set(bookmark, forKey: Self.bookmarkKey)
        defaults.set(url.lastPathComponent, forKey: Self.nameKey)
        defaults.set(url.path, forKey: Self.pathKey)
        resolve(url.path)
      } catch {
        reject("E_BOOKMARK", "could not remember that folder: \(error.localizedDescription)", error)
      }
    }
  }

  @objc func downloadFolderName(_ resolve: @escaping RCTPromiseResolveBlock,
                                reject: @escaping RCTPromiseRejectBlock) {
    let defaults = UserDefaults.standard
    // The PATH when there is one, and the bare name only for a folder chosen by
    // a build that did not record it.
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

  /// MOVE each received file into the remembered folder, and answer where each
  /// one landed, in the same order.
  ///
  /// A MOVE, not a copy: the engine's copy is the same bytes, and leaving it
  /// behind means every received file is stored twice with one of the two
  /// invisible. With no folder remembered the paths come back UNCHANGED, which
  /// is what makes the feature degrade to the old behavior.
  ///
  /// A file that cannot be moved keeps its ORIGINAL path. That is the honest
  /// answer -- the file is still where the engine put it -- and it is why this
  /// returns one location per input rather than failing as a batch.
  @objc func moveReceivedFiles(_ paths: [String],
                               resolve: @escaping RCTPromiseResolveBlock,
                               reject: @escaping RCTPromiseRejectBlock) {
    guard let bookmark = UserDefaults.standard.data(forKey: Self.bookmarkKey) else {
      resolve(paths)
      return
    }
    var stale = false
    // `.withSecurityScope` on BOTH sides. A bookmark created with the option
    // and resolved without it does not resolve, and the failure here is silent
    // by design -- the input comes back unchanged -- so the move simply never
    // happened and nothing said why.
    guard let folder = try? URL(
      resolvingBookmarkData: bookmark,
      options: [.withSecurityScope],
      relativeTo: nil,
      bookmarkDataIsStale: &stale)
    else {
      // The bookmark no longer resolves: the folder moved, or the volume is
      // gone. Answer with the input rather than failing the whole receive.
      resolve(paths)
      return
    }
    let scoped = folder.startAccessingSecurityScopedResource()
    defer { if scoped { folder.stopAccessingSecurityScopedResource() } }

    let fm = FileManager.default
    var out: [String] = []
    for path in paths {
      let src = URL(fileURLWithPath: path)
      var dest = folder.appendingPathComponent(src.lastPathComponent)
      // Never overwrite: two files called `photo.jpg` from two senders are two
      // files, and the second must not silently replace the first.
      var n = 1
      while fm.fileExists(atPath: dest.path) {
        let base = src.deletingPathExtension().lastPathComponent
        let ext = src.pathExtension
        let name = ext.isEmpty ? "\(base)-\(n)" : "\(base)-\(n).\(ext)"
        dest = folder.appendingPathComponent(name)
        n += 1
      }
      do {
        try fm.moveItem(at: src, to: dest)
        out.append(dest.path)
      } catch {
        out.append(path)
      }
    }
    resolve(out)
  }
}
