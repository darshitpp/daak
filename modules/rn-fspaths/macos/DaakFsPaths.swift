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

  /// Opens the file in its default app (Preview for a PDF). `reveal` selects
  /// the file in Finder; this starts the viewer. Resolves false for a path that
  /// does not exist and for a file with no app that can open it.
  @objc func openFile(_ path: String,
                      resolve: @escaping RCTPromiseResolveBlock,
                      reject: @escaping RCTPromiseRejectBlock) {
    let url = URL(fileURLWithPath: path)
    // The App Sandbox is on. A file in the folder the user chose lies outside
    // the container, so the folder's security scope must be open while the
    // file is checked and opened. Resolve the bookmark the way
    // `moveReceivedFiles` does.
    var folder: URL?
    if let bookmark = UserDefaults.standard.data(forKey: Self.bookmarkKey) {
      var stale = false
      if let f = try? URL(
        resolvingBookmarkData: bookmark, options: [.withSecurityScope],
        relativeTo: nil, bookmarkDataIsStale: &stale),
        f.startAccessingSecurityScopedResource() {
        folder = f
      }
    }
    guard FileManager.default.fileExists(atPath: path) else {
      folder?.stopAccessingSecurityScopedResource()
      resolve(false)
      return
    }
    DispatchQueue.main.async {
      let ok = NSWorkspace.shared.open(url)
      folder?.stopAccessingSecurityScopedResource()
      resolve(ok)
    }
  }

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

  /// The file count and total bytes under a folder. A symlink is skipped, so a
  /// link cannot pull in a tree outside the folder or loop forever. `NSNull`
  /// marks a path that is not a readable folder.
  @objc func folderStats(_ path: String,
                         resolve: @escaping RCTPromiseResolveBlock,
                         reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      let root = URL(fileURLWithPath: path)
      let keys: [URLResourceKey] = [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]
      let values = try? root.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
      // The walk calls the handler on the queue of this block, so a plain
      // flag is safe.
      var unreadable = false
      // A root that exists but cannot be read gives an empty walk and no error.
      // So read the root first.
      guard values?.isDirectory == true, values?.isSymbolicLink != true,
            (try? FileManager.default.contentsOfDirectory(atPath: root.path)) != nil,
            let walker = FileManager.default.enumerator(
              at: root, includingPropertiesForKeys: keys, options: [],
              errorHandler: { _, error in
                NSLog("Daak: folderStats could not read an item (\((error as NSError).domain) \((error as NSError).code))")
                unreadable = true
                return false
              })
      else {
        resolve(NSNull())
        return
      }
      var files = 0
      var bytes = 0
      for case let url as URL in walker {
        guard let v = try? url.resourceValues(forKeys: Set(keys)),
              v.isSymbolicLink != true, v.isRegularFile == true else { continue }
        files += 1
        bytes += v.fileSize ?? 0
      }
      if unreadable {
        resolve(NSNull())
        return
      }
      resolve(["files": files, "bytes": bytes])
    }
  }

  /// No copy exists on macOS: the engine reads the chosen folder in place.
  @objc func discardPickedCopy(_ path: String,
                               resolve: @escaping RCTPromiseResolveBlock,
                               reject: @escaping RCTPromiseRejectBlock) {
    resolve(NSNull())
  }

  /// No copy exists on macOS, so there is nothing to sweep.
  @objc func sweepPickedCopies(_ resolve: @escaping RCTPromiseResolveBlock,
                               reject: @escaping RCTPromiseRejectBlock) {
    resolve(NSNull())
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
        reject("E_BOOKMARK", "could not remember that folder", nil)
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
  ///
  /// `subdirs[i]` is the folder below the remembered folder for `paths[i]`, for
  /// example `album/sub`. Its first name is the root. Each root gets the first
  /// free name in the folder (`album`, `album-1`, ...), so a moved folder never
  /// merges into a folder that exists. A subdir that starts with `/` names a
  /// root that the payload already uses, and that root is used as it is.
  /// A file that is already in the folder answers its own path and does not
  /// move, so a second call moves nothing twice. After the move, the empty
  /// folders that the engine made below its output directory are removed.
  @objc func moveReceivedFiles(_ paths: [String],
                               subdirs: [String],
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
    let norm = { (u: URL) in Self.withoutPrivate(u.standardizedFileURL.resolvingSymlinksInPath().path) }
    let folderAt = norm(folder) + "/"
    let outAt = norm(Self.dataDir().appendingPathComponent("downloads", isDirectory: true)) + "/"
    // Task 12b (F4): the root name that this call uses for each requested root.
    var roots: [String: String] = [:]
    var out: [String] = []
    for (i, path) in paths.enumerated() {
      let src = URL(fileURLWithPath: path)
      // The file is already in the save folder: an earlier event moved it. The
      // save folder can hold the engine output folder, so that folder does not count.
      let srcAt = norm(src)
      if srcAt.hasPrefix(folderAt) && !srcAt.hasPrefix(outAt) {
        out.append(path)
        continue
      }
      let subdir = i < subdirs.count ? subdirs[i] : ""
      var parts = Self.safeParts(subdir)
      if !parts.isEmpty {
        parts[0] = Self.chooseRoot(parts[0], exact: subdir.hasPrefix("/"), in: folder,
                                   roots: &roots, fm: fm)
      }
      var target = folder
      for part in parts {
        target.appendPathComponent(part, isDirectory: true)
      }
      do {
        try fm.createDirectory(at: target, withIntermediateDirectories: true)
      } catch {
        NSLog("Daak: could not make a folder in the download folder (\((error as NSError).domain) \((error as NSError).code))")
        out.append(path)
        continue
      }
      var dest = target.appendingPathComponent(src.lastPathComponent)
      // Never overwrite: two files called `photo.jpg` from two senders are two
      // files, and the second must not silently replace the first.
      var n = 1
      while fm.fileExists(atPath: dest.path) {
        let base = src.deletingPathExtension().lastPathComponent
        let ext = src.pathExtension
        let name = ext.isEmpty ? "\(base)-\(n)" : "\(base)-\(n).\(ext)"
        dest = target.appendingPathComponent(name)
        n += 1
      }
      do {
        try fm.moveItem(at: src, to: dest)
        out.append(dest.path)
      } catch {
        out.append(path)
      }
    }
    Self.pruneEmptyDirs(paths)
    resolve(out)
  }

  /// The folder names of a subdir. An empty part, `.`, and `..` are dropped, so
  /// a subdir can never point above the chosen folder.
  private static func safeParts(_ subdir: String) -> [String] {
    subdir.split(separator: "/").map(String.init)
      .filter { !$0.isEmpty && $0 != "." && $0 != ".." }
  }

  /// `resolvingSymlinksInPath` drops a leading `/private` only when the path
  /// exists. So drop it on both sides of a compare.
  private static func withoutPrivate(_ path: String) -> String {
    path.hasPrefix("/private/") ? String(path.dropFirst("/private".count)) : path
  }

  /// Task 12b (F4): the root folder name in the save folder for a requested
  /// root. An exact root (the subdir starts with `/`) is used as it is. Any
  /// other root gets the first free name of `name`, `name-1`, `name-2`, ...
  /// The chosen folder is made at once, so the file system decides if a later
  /// name is free. One requested root gets one name for each call.
  private static func chooseRoot(_ name: String, exact: Bool, in folder: URL,
                                 roots: inout [String: String], fm: FileManager) -> String {
    let key = exact ? "/" + name : name
    if let known = roots[key] {
      return known
    }
    var chosen = name
    if !exact {
      let taken = Set(roots.values)
      var n = 1
      while taken.contains(chosen) || fm.fileExists(atPath: folder.appendingPathComponent(chosen).path) {
        chosen = "\(name)-\(n)"
        n += 1
      }
      try? fm.createDirectory(at: folder.appendingPathComponent(chosen, isDirectory: true),
                              withIntermediateDirectories: true)
    }
    roots[key] = chosen
    return chosen
  }

  /// Remove each folder that is now empty, from the folder of each source up to
  /// the engine output directory. The output directory itself stays. A folder
  /// outside it is never touched. A folder that still holds a file stops the walk.
  private static func pruneEmptyDirs(_ sources: [String]) {
    let fm = FileManager.default
    let outDir = withoutPrivate(dataDir().appendingPathComponent("downloads", isDirectory: true)
      .standardizedFileURL.resolvingSymlinksInPath().path)
    for path in sources {
      var dir = URL(fileURLWithPath: path).deletingLastPathComponent()
      while true {
        let at = withoutPrivate(dir.standardizedFileURL.resolvingSymlinksInPath().path)
        guard at.hasPrefix(outDir + "/") else { break }
        guard let left = try? fm.contentsOfDirectory(atPath: at), left.isEmpty else { break }
        // rmdir(2) removes only an EMPTY folder. A file that arrives after the
        // check above makes it fail, and the file stays. removeItem would
        // delete the folder and that file. A failure only stops the walk.
        guard rmdir(at) == 0 else { break }
        dir = dir.deletingLastPathComponent()
      }
    }
  }

  // macOS has no Photos support yet (R8). The shared relocate code calls these.
  // `albums` is ignored.
  @objc func saveToLibrary(_ paths: [String],
                           albums: [String],
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
}
