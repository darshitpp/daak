package dev.darshit.daak.fspaths

import android.content.ContentValues
import android.content.Intent
import android.app.Activity
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.provider.MediaStore
import android.provider.DocumentsContract
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableNativeArray
import com.facebook.react.module.annotations.ReactModule
import java.io.File
import java.nio.file.Files
import kotlin.concurrent.thread

@ReactModule(name = DaakFsPathsModule.NAME)
class DaakFsPathsModule(reactContext: ReactApplicationContext) :
    NativeDaakFsPathsSpec(reactContext), ActivityEventListener {

  companion object {
    const val NAME = "DaakFsPaths"

    /**
     * The authority the app AndroidManifest declares for THIS module's
     * provider. Two providers cannot share an authority, and
     * FileProvider.getUriForFile throws IllegalArgumentException on an
     * authority that is not in the merged manifest -- so the resource and the
     * declaration are pinned together by
     * apps/mobile/src/__tests__/fspathsManifest.test.ts.
     */
    const val AUTHORITY_SUFFIX = ".fileprovider"

    /** R42p: where the chosen destination folder lives between launches. */
    private const val PREFS = "daak.fspaths"
    private const val KEY_TREE = "downloadFolderTree"
    private const val KEY_NAME = "downloadFolderName"
    private const val REQUEST_TREE = 47011

    /** The public folder for a document when the user chose no folder. */
    const val DEFAULT_FOLDER = "Download/Daak"

    /** The longest file name, in characters, that a MediaStore insert gets. */
    const val MAX_NAME = 200
  }

  init {
    reactApplicationContext.addActivityEventListener(this)
  }

  private var pendingChoose: Promise? = null

  override fun getName() = NAME

  /**
   * The engine's DATA DIR, resolved the same way DaakModule.kt's start()
   * resolves it: `filesDir/daak`. Not bare filesDir, and deliberately NOT
   * getExternalFilesDir(DIRECTORY_DOCUMENTS) -- one root holds the database, the
   * keys and every saved file.
   */
  @ReactMethod
  override fun documentsDir(promise: Promise) = resolve(promise) { dataDir().absolutePath }

  /**
   * The engine's RECEIVE ROOT: `<data_dir>/downloads`, which is exactly the
   * `dir.join("downloads")` out_dir that daak-ffi's start() hands the engine.
   *
   * This returned the EXTERNAL app-specific Download/ before, which is inside
   * the sandbox but is NOT where the engine writes -- so on Android the user saw
   * "no files received" for files that had been received. Two directories under
   * one name is how files end up in two places.
   */
  @ReactMethod
  override fun downloadsDir(promise: Promise) =
      resolve(promise) { File(dataDir(), "downloads").absolutePath }

  /**
   * There is no iOS-style App Group on Android. Returning filesDir here would
   * be a LIE about sharing: the share EXTENSION is a separate package with its
   * own private filesDir, so anything written to this value is invisible to it.
   * "" is the honest answer -- "there is no shared container here" -- and it is
   * an ANSWER, not a failure, so the JS side can branch on it. The real
   * Android cross-process channel is the FileProvider, used by reveal below.
   */
  @ReactMethod
  override fun appGroupDir(promise: Promise) = resolve(promise) { "" }

  /**
   * ACTION_VIEW on a FileProvider URI, which is the only way to point another
   * app at a file inside this sandbox (a file:// URI throws
   * FileUriExposedException on API 24+). Grants are per-Intent and the
   * provider is not exported, so nothing else can read the path.
   *
   * Resolves false rather than rejecting for the ordinary "there is no app
   * that can open this" answer -- the caller is a notification action, and a
   * rejection there is an unhandled promise in a handler that must not die.
   */
  @ReactMethod
  override fun reveal(path: String, promise: Promise) = resolve(promise) {
    // R42p: a file the user asked to keep elsewhere was MOVED into a SAF tree,
    // and its recorded location is a content:// URI -- there is no File behind
    // it, so FileProvider.getUriForFile can do nothing with it. Open the tree
    // document directly. Without this the Inbox's Show verb stops working on
    // exactly the files the destination feature produced.
    if (path.startsWith("content://")) {
      val uri = Uri.parse(path)
      val open = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, typeFor(uri))
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      if (open.resolveActivity(reactApplicationContext.packageManager) == null) {
        return@resolve false
      }
      reactApplicationContext.startActivity(open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      return@resolve true
    }
    val file = File(path)
    if (!file.exists()) return@resolve false
    val uri = FileProvider.getUriForFile(
      reactApplicationContext,
      reactApplicationContext.packageName + AUTHORITY_SUFFIX,
      file,
    )
    val intent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, typeFor(uri))
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    val launched =
        if (intent.resolveActivity(reactApplicationContext.packageManager) != null) {
          reactApplicationContext.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
          true
        } else {
          false
        }
    launched
  }

  /**
   * The same `File(path).exists()` reveal already inlined above, exposed --
   * so a caller can ask without launching an intent. Resolves false for a path
   * that is not there: "no such file" is an ANSWER, not a failure, and a
   * reveal action must not die on an unhandled rejection. A content:// URI is a
   * MediaStore or SAF document. File() cannot test it, and no caller needs the
   * answer yet.
   */
  @ReactMethod
  override fun exists(path: String, promise: Promise) =
      resolve(promise) { path.startsWith("content://") || File(path).exists() }

  /**
   * The size of each staged file. A path that is missing, unreadable, or not a
   * regular file answers null, so one bad path does not lose the others.
   */
  @ReactMethod
  override fun fileSizes(paths: ReadableArray, promise: Promise) = resolve(promise) {
    val out = WritableNativeArray()
    for (i in 0 until paths.size()) {
      val file = File(paths.getString(i) ?: "")
      if (file.isFile) out.pushDouble(file.length().toDouble()) else out.pushNull()
    }
    out
  }

  /**
   * The Preview verb. `reveal` already starts ACTION_VIEW through the file
   * provider and resolves false when no app can open the type, so `openFile`
   * reuses it. The two verbs differ only on iOS and macOS.
   */
  @ReactMethod
  override fun openFile(path: String, promise: Promise) = reveal(path, promise)

  /**
   * The free bytes for the send cache. This is `StatFs.availableBytes`, the
   * conservative value. `requireSpace` in rn-share checks the same value, so a
   * send that fits here does not fail that check later. `getAllocatableBytes`
   * also counts cache that the system can clear. The final review removed it,
   * because the copy can then fill the disk. It runs off the main thread. A
   * failure rejects with a message that has no path.
   */
  @ReactMethod
  override fun freeBytes(promise: Promise) {
    thread(name = "daak-free-bytes") {
      try {
        val cacheDir = reactApplicationContext.cacheDir
        val bytes = StatFs(cacheDir.path).availableBytes
        // A Long can exceed 2^53 in theory. A real disk does not.
        promise.resolve(bytes.coerceAtLeast(0L).toDouble())
      } catch (_: Throwable) {
        promise.reject("E_FSPATHS", "the free space could not be read")
      }
    }
  }

  /**
   * The file count and total bytes of a folder tree. Hidden files count. A
   * symlink is skipped. Resolves null when the root is not a folder, the root
   * is a symlink, or a folder in the tree cannot be listed.
   */
  @ReactMethod
  override fun folderStats(path: String, promise: Promise) {
    thread(name = "daak-folder-stats") {
      try {
        val root = File(path)
        if (!root.isDirectory || Files.isSymbolicLink(root.toPath())) {
          promise.resolve(null)
          return@thread
        }
        var files = 0L
        var bytes = 0L
        val todo = mutableListOf(root)
        while (todo.isNotEmpty()) {
          val children = todo.removeAt(todo.lastIndex).listFiles()
          if (children == null) {
            promise.resolve(null)
            return@thread
          }
          for (child in children) {
            if (Files.isSymbolicLink(child.toPath())) continue
            if (child.isDirectory) {
              todo.add(child)
            } else if (child.isFile) {
              files += 1
              bytes += child.length()
            }
          }
        }
        promise.resolve(Arguments.createMap().apply {
          putDouble("files", files.toDouble())
          putDouble("bytes", bytes.toDouble())
        })
      } catch (_: Throwable) {
        promise.reject("E_FSPATHS", "the file operation did not complete")
      }
    }
  }

  /**
   * `<cacheDir>/daak-send`, the parent of every copy that
   * DaakShareModule.pickFolder makes. Keep this path equal to the one in
   * DaakShareModule.copyPickedFolder.
   */
  private fun pickedCopiesRoot() = File(reactApplicationContext.cacheDir, "daak-send")

  /**
   * Delete one copy that pickFolder made: the whole `<uuid>` slot that holds
   * `path`. Rejects a path that is not below `<cacheDir>/daak-send` after the
   * symlinks and the `..` parts are resolved.
   */
  @ReactMethod
  override fun discardPickedCopy(path: String, promise: Promise) {
    thread(name = "daak-discard-copy") {
      try {
        val rootDir = pickedCopiesRoot().apply { mkdirs() }
        // canonicalFile resolves the symlinks and the `..` parts. Path.startsWith
        // then compares whole components, so `daak-sendX` is not under `daak-send`.
        val root = rootDir.canonicalFile.toPath()
        val target = File(path).canonicalFile.toPath()
        if (!target.startsWith(root) || target == root) {
          promise.reject("E_NOT_PICKED_COPY", "the path is not a copy under daak-send")
          return@thread
        }
        val slot = root.resolve(root.relativize(target).getName(0)).toFile()
        // A copy that is already gone is the wanted result.
        if (!slot.exists() || slot.deleteRecursively()) {
          promise.resolve(null)
        } else {
          promise.reject("E_DISCARD", "the copy could not be deleted")
        }
      } catch (_: Throwable) {
        promise.reject("E_DISCARD", "the copy could not be deleted")
      }
    }
  }

  /**
   * Delete every copy under `<cacheDir>/daak-send` that an earlier run left.
   * A slot made after this sweep started belongs to a pick that runs now, so
   * the sweep keeps it. The kernel writes file times from a coarse clock that
   * can be some milliseconds behind currentTimeMillis, so the start time is 1 s
   * early. An earlier run stopped more than 1 s before this start.
   */
  @ReactMethod
  override fun sweepPickedCopies(promise: Promise) {
    val started = System.currentTimeMillis() - 1_000
    thread(name = "daak-sweep-copies") {
      // An uncaught throw on this thread stops the app, so catch everything.
      try {
        for (slot in pickedCopiesRoot().listFiles() ?: emptyArray()) {
          if (slot.lastModified() >= started) continue
          if (!slot.deleteRecursively()) {
            android.util.Log.w("DaakFsPaths", "sweep: an old folder copy could not be deleted")
          }
        }
        promise.resolve(null)
      } catch (_: Throwable) {
        promise.reject("E_SWEEP", "the old copies could not be deleted")
      }
    }
  }

  private inline fun resolve(promise: Promise, block: () -> Any?) {
    try { promise.resolve(block()) } catch (_: Throwable) { promise.reject("E_FSPATHS", "the file operation did not complete") }
  }

  private fun prefs(): SharedPreferences =
      reactApplicationContext.getSharedPreferences(
          PREFS, android.content.Context.MODE_PRIVATE)

  /**
   * R42p: ask for a destination folder with ACTION_OPEN_DOCUMENT_TREE.
   *
   * SAF hands back a content:// TREE URI, not a filesystem path. That is why the
   * move is done here and not by the engine: the engine writes with std::fs and
   * a PathBuf, and a tree URI can be neither. The grant is persisted with
   * takePersistableUriPermission, because without it the permission is gone at
   * the next launch -- the Android spelling of the macOS bookmark.
   */
  @ReactMethod
  override fun chooseDownloadFolder(promise: Promise) {
    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      // No foreground activity: nothing can be shown, so nothing changed.
      promise.resolve(null)
      return
    }
    pendingChoose = promise
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
      addFlags(
          Intent.FLAG_GRANT_READ_URI_PERMISSION or
              Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
              Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
              Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
    }
    activity.startActivityForResult(intent, REQUEST_TREE)
  }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode != REQUEST_TREE) return
    val promise = pendingChoose ?: return
    pendingChoose = null
    val tree = if (resultCode == Activity.RESULT_OK) data?.data else null
    if (tree == null) {
      // A cancelled picker is an ANSWER, not an error: nothing changed.
      promise.resolve(null)
      return
    }
    try {
      reactApplicationContext.contentResolver.takePersistableUriPermission(
          tree,
          Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      val name = tree.lastPathSegment?.substringAfterLast('/')
      prefs().edit().putString(KEY_TREE, tree.toString()).putString(KEY_NAME, name).apply()
      promise.resolve(name)
    } catch (_: Throwable) {
      promise.reject("E_TREE", "could not keep that folder")
    }
  }

  override fun onNewIntent(intent: Intent) {}

  @ReactMethod
  override fun downloadFolderName(promise: Promise) =
      // The TREE URI, not the display name: on Android the location of a SAF
      // folder IS the URI, and a bare name would not say where the files go.
      resolve(promise) {
        prefs().getString(KEY_TREE, null) ?: prefs().getString(KEY_NAME, null)
            // No folder chosen: API 29 and later save documents to Download/Daak.
            ?: if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) DEFAULT_FOLDER else null
      }

  @ReactMethod
  override fun clearDownloadFolder(promise: Promise) = resolve(promise) {
    prefs().edit().remove(KEY_TREE).remove(KEY_NAME).apply()
    null
  }

  /**
   * R42p: MOVE each received file into the tree the user chose, answering one
   * location per input.
   *
   * A file that cannot be moved keeps its ORIGINAL path, so one failure never
   * loses the locations of the others, and an unset folder answers the input
   * unchanged -- which is what makes the feature degrade to the old behavior.
   *
   * The answer for a moved file is a content:// URI, not a path, because that
   * is what the tree gives. The Inbox's open verb must accept it.
   *
   * `subdirs[i]` is the folder below the tree for `paths[i]`, for example
   * `album/sub`. Its first name is the root. Each root gets the first free name
   * in the tree (`album`, `album-1`, ...), so a moved folder never merges into
   * a folder that exists. A subdir that starts with "/" names a root that the
   * payload already uses, and that root is used as it is. Each directory below
   * the root is found or created in the tree. A moved file is a content:// URI,
   * and JavaScript does not send it again, so a second call never moves a file
   * twice. After the move, the empty folders that the engine made below its
   * output directory are removed.
   */
  @ReactMethod
  override fun moveReceivedFiles(paths: ReadableArray, subdirs: ReadableArray, promise: Promise) =
      resolve(promise) {
    // The generated spec hands a ReadableArray in and takes a WritableArray
    // back; that is the Android bridge's own shape for string[], and converting
    // to List<String> here would not satisfy the abstract member. A null entry
    // becomes "", so the answer count always equals the input count.
    val input = (0 until paths.size()).map { paths.getString(it) ?: "" }
    val treeUri = prefs().getString(KEY_TREE, null)?.let(Uri::parse)
    if (treeUri == null) {
      // No folder chosen. Below API 29 the input comes back unchanged. From
      // API 29, a document goes to Download/Daak in MediaStore.
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return@resolve writable(input)
      return@resolve writable(saveDocuments(input, subdirs))
    }
    val resolver = reactApplicationContext.contentResolver
    val root =
        DocumentsContract.buildDocumentUriUsingTree(
            treeUri, DocumentsContract.getTreeDocumentId(treeUri))
    // One lookup for each subdir in this call, not one for each file.
    val dirs = HashMap<String, Uri?>()
    // Task 12b (F4): the root name that this call uses for each requested root.
    val roots = HashMap<String, String>()
    val out = input.mapIndexed { i, path ->
      val src = File(path)
      if (path.isEmpty() || !src.exists()) return@mapIndexed path
      try {
        val subdir = parallelAt(subdirs, i)
        val parts = withRoot(treeUri, root, safeParts(subdir.split("/")), subdir.startsWith("/"), roots)
        val key = parts.joinToString("/")
        val parent = if (dirs.containsKey(key)) dirs[key] else {
          safDir(treeUri, root, parts).also { dirs[key] = it }
        }
        if (parent == null) return@mapIndexed path
        val dest = DocumentsContract.createDocument(resolver, parent, guessMime(src.name), src.name)
        if (dest == null) return@mapIndexed path
        resolver.openOutputStream(dest)?.use { o ->
          src.inputStream().use { input -> input.copyTo(o) }
        } ?: return@mapIndexed path
        src.delete()
        dest.toString()
      } catch (_: Throwable) {
        path
      }
    }
    // Best effort. A throw here must not reject the promise: the files already
    // moved, and JavaScript must still get the new paths.
    runCatching { pruneEmptyDirs(input) }.onFailure {
      android.util.Log.w("DaakFsPaths", "the empty folders could not be removed: ${it.javaClass.simpleName}")
    }
    writable(out)
  }

  /**
   * Add each image or video to MediaStore. One answer per input.
   *
   * Android 10 (API 29) and later let any app add media with no permission.
   * Below 29 the input comes back unchanged and the folder move runs.
   *
   * `albums[i]` is the album for `paths[i]` in the JavaScript form `album / sub`.
   * The file goes to `Pictures/Daak/album/sub` (or `Movies/Daak/...`). After
   * the save, the empty folders that the engine made below its output
   * directory are removed.
   */
  @ReactMethod
  override fun saveToLibrary(paths: ReadableArray, albums: ReadableArray, promise: Promise) =
      resolve(promise) {
    // A null entry becomes "". saveOne returns it unchanged, so the answer count
    // always equals the input count.
    val input = (0 until paths.size()).map { paths.getString(it) ?: "" }
    val out = input.mapIndexed { i, path ->
      try { saveOne(path, parallelAt(albums, i)) } catch (_: Throwable) { path }
    }
    // Best effort. A throw here must not reject the promise: the files already
    // moved, and JavaScript must still get the new paths.
    runCatching { pruneEmptyDirs(input) }.onFailure {
      android.util.Log.w("DaakFsPaths", "the empty folders could not be removed: ${it.javaClass.simpleName}")
    }
    writable(out)
  }

  /** Entry `i` of a parallel array. A short array or a null entry is "". */
  private fun parallelAt(values: ReadableArray, i: Int): String =
      if (i < values.size()) values.getString(i) ?: "" else ""

  /**
   * The folder names of a subdir or an album. An empty part, `.`, and `..` are
   * dropped, so a name can never point above the chosen folder.
   */
  private fun safeParts(parts: List<String>): List<String> =
      parts.filter { it.isNotEmpty() && it != "." && it != ".." }

  /**
   * Task 12b (F4): `parts` with its first name replaced by the root that this
   * call uses for it. An exact root (the subdir starts with "/") is used as it
   * is. Any other root gets the first free name of `name`, `name-1`, `name-2`,
   * ... in the tree. One requested root gets one name for each call.
   */
  private fun withRoot(
      treeUri: Uri,
      root: Uri,
      parts: List<String>,
      exact: Boolean,
      roots: HashMap<String, String>
  ): List<String> {
    if (parts.isEmpty()) return parts
    val name = parts[0]
    val key = if (exact) "/$name" else name
    val chosen = roots[key] ?: (if (exact) name else freeName(treeUri, root, name, roots.values.toSet()))
    roots[key] = chosen
    return listOf(chosen) + parts.drop(1)
  }

  /**
   * The first name of `name`, `name-1`, `name-2`, ... that no child of `root`
   * has and that this call did not choose. The compare ignores case, because
   * shared storage ignores case and the provider would rename the folder.
   */
  private fun freeName(treeUri: Uri, root: Uri, name: String, taken: Set<String>): String {
    val children = DocumentsContract.buildChildDocumentsUriUsingTree(
        treeUri, DocumentsContract.getDocumentId(root))
    val names = ArrayList<String>()
    reactApplicationContext.contentResolver.query(
        children, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { c ->
      while (c.moveToNext()) {
        c.getString(0)?.let { names.add(it) }
      }
    }
    var chosen = name
    var n = 1
    while (taken.any { it.equals(chosen, ignoreCase = true) } ||
        names.any { it.equals(chosen, ignoreCase = true) }) {
      chosen = "$name-$n"
      n += 1
    }
    return chosen
  }

  /**
   * Find or create each directory of `parts` below `root` in the tree. An
   * existing child directory with the same name is used again, so a second
   * file of one folder does not make `album (1)`. Null when a step fails.
   */
  private fun safDir(treeUri: Uri, root: Uri, parts: List<String>): Uri? {
    val resolver = reactApplicationContext.contentResolver
    var parent = root
    for (name in parts) {
      val children = DocumentsContract.buildChildDocumentsUriUsingTree(
          treeUri, DocumentsContract.getDocumentId(parent))
      var found: Uri? = null
      resolver.query(
          children,
          arrayOf(
              DocumentsContract.Document.COLUMN_DOCUMENT_ID,
              DocumentsContract.Document.COLUMN_DISPLAY_NAME,
              DocumentsContract.Document.COLUMN_MIME_TYPE),
          null, null, null)?.use { c ->
        while (found == null && c.moveToNext()) {
          if (c.getString(1) == name &&
              c.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR) {
            found = DocumentsContract.buildDocumentUriUsingTree(treeUri, c.getString(0))
          }
        }
      }
      parent = found
          ?: DocumentsContract.createDocument(
              resolver, parent, DocumentsContract.Document.MIME_TYPE_DIR, name)
          ?: return null
    }
    return parent
  }

  /**
   * Remove each folder that is now empty, from the folder of each source up to
   * the engine output directory. The output directory itself stays. A folder
   * outside it is never touched. A folder that still holds a file stops the walk.
   */
  private fun pruneEmptyDirs(sources: List<String>) {
    val outDir = File(dataDir(), "downloads").canonicalFile.toPath()
    for (path in sources) {
      if (path.isEmpty() || path.startsWith("content://")) continue
      var dir: File? = try { File(path).canonicalFile.parentFile } catch (_: Throwable) { null }
      while (dir != null) {
        val at = dir.toPath()
        if (!at.startsWith(outDir) || at == outDir) break
        if (dir.list()?.isEmpty() != true) break
        if (!dir.delete()) break
        dir = dir.parentFile
      }
    }
  }

  /** No permission exists to ask for on Android 10 and later. */
  @ReactMethod
  override fun requestPhotosAccess(promise: Promise) = resolve(promise) {
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
  }

  @ReactMethod
  override fun photosAccessStatus(promise: Promise) = resolve(promise) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) "granted" else "unavailable"
  }

  /**
   * One file. Writes the row as pending, copies the bytes, then clears the
   * pending flag, so no other app sees a half-written file. The source is
   * deleted only after that. A failure removes the row and keeps the source.
   *
   * `album` is `album / sub` (the JavaScript form). It becomes the nested path
   * `album/sub` below `Pictures/Daak` or `Movies/Daak`. MediaStore makes each
   * missing folder. A path that MediaStore refuses throws, and the caller then
   * answers the original path, so the folder move takes the file.
   */
  private fun saveOne(path: String, album: String): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return path
    val src = File(path)
    if (!src.exists()) return path
    val mime = guessMime(src.name)
    val (collection, folder) = when {
      mime.startsWith("image/") ->
          MediaStore.Images.Media.EXTERNAL_CONTENT_URI to Environment.DIRECTORY_PICTURES
      mime.startsWith("video/") ->
          MediaStore.Video.Media.EXTERNAL_CONTENT_URI to Environment.DIRECTORY_MOVIES
      else -> return path
    }
    val resolver = reactApplicationContext.contentResolver
    val dirs = safeParts(album.split(" / ")).joinToString("/")
    val values = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, src.name)
      put(MediaStore.MediaColumns.MIME_TYPE, mime)
      put(MediaStore.MediaColumns.RELATIVE_PATH, if (dirs.isEmpty()) "$folder/Daak" else "$folder/Daak/$dirs")
      put(MediaStore.MediaColumns.IS_PENDING, 1)
    }
    val uri = resolver.insert(collection, values) ?: return path
    return try {
      val out = resolver.openOutputStream(uri) ?: throw IllegalStateException("no output stream")
      out.use { o -> src.inputStream().use { it.copyTo(o) } }
      // The update must change 1 row. A row that stays pending expires after
      // about 7 days and MediaStore then removes it. The source must still exist
      // in that case, so the throw below keeps the source and removes the row.
      val updated = resolver.update(uri, ContentValues().apply {
        put(MediaStore.MediaColumns.IS_PENDING, 0)
      }, null, null)
      if (updated != 1) throw IllegalStateException("pending not cleared")
      if (!src.delete()) {
        android.util.Log.w("DaakFsPaths", "saved item but could not delete source")
      }
      uri.toString()
    } catch (_: Throwable) {
      try { resolver.delete(uri, null, null) } catch (_: Throwable) {}
      path
    }
  }

  /**
   * True for a file below `<data_dir>/downloads/quarantine`. A file that failed
   * the hash check stays there. Only an item in state `done` is moved.
   */
  private fun isQuarantined(src: File): Boolean =
      src.canonicalFile.toPath().startsWith(
          File(dataDir(), "downloads/quarantine").canonicalFile.toPath())

  /**
   * A file name that is safe for a MediaStore insert. A path separator and a
   * control character become `_`. A name of `.` or `..` or a blank name becomes
   * `file`. A name over MAX_NAME characters is cut, and the extension stays.
   */
  private fun cleanName(name: String): String {
    val flat = name.map { if (it == '/' || it == '\\' || Character.isISOControl(it)) '_' else it }
        .joinToString("").trim()
    val base = if (flat.isEmpty() || flat == "." || flat == "..") "file" else flat
    if (base.length <= MAX_NAME) return base
    val dot = base.lastIndexOf('.')
    val ext = if (dot > 0 && base.length - dot <= 16) base.substring(dot) else ""
    return base.substring(0, MAX_NAME - ext.length) + ext
  }

  /** Save each document to Download/Daak, then remove the empty source folders. */
  private fun saveDocuments(input: List<String>, subdirs: ReadableArray): List<String> {
    val saved = input.mapIndexed { i, path ->
      try { saveDocument(path, parallelAt(subdirs, i)) } catch (_: Throwable) { path }
    }
    // Best effort. A throw here must not reject the promise.
    runCatching { pruneEmptyDirs(input) }.onFailure {
      android.util.Log.w("DaakFsPaths", "the empty folders could not be removed: ${it.javaClass.simpleName}")
    }
    return saved
  }

  /**
   * One document, saved to `Download/Daak[/subdir]` in MediaStore. It has the
   * same steps as saveOne: pending row, copy, clear pending, check 1 row, delete
   * the source. A failure removes the row and answers the original path. An
   * image or a video stays for saveToLibrary. A quarantined file never moves.
   */
  private fun saveDocument(path: String, subdir: String): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return path
    val src = File(path)
    if (path.isEmpty() || !src.isFile) return path
    if (isQuarantined(src)) return path
    val mime = guessMime(src.name)
    if (mime.startsWith("image/") || mime.startsWith("video/")) return path
    val resolver = reactApplicationContext.contentResolver
    val dirs = safeParts(subdir.split("/")).map { cleanName(it) }.joinToString("/")
    val values = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, cleanName(src.name))
      put(MediaStore.MediaColumns.MIME_TYPE, mime)
      put(MediaStore.MediaColumns.RELATIVE_PATH, if (dirs.isEmpty()) DEFAULT_FOLDER else "$DEFAULT_FOLDER/$dirs")
      put(MediaStore.MediaColumns.IS_PENDING, 1)
    }
    val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return path
    return try {
      val out = resolver.openOutputStream(uri) ?: throw IllegalStateException("no output stream")
      out.use { o -> src.inputStream().use { it.copyTo(o) } }
      val updated = resolver.update(uri, ContentValues().apply {
        put(MediaStore.MediaColumns.IS_PENDING, 0)
      }, null, null)
      if (updated != 1) throw IllegalStateException("pending not cleared")
      if (!src.delete()) {
        android.util.Log.w("DaakFsPaths", "saved document but could not delete source")
      }
      uri.toString()
    } catch (_: Throwable) {
      try { resolver.delete(uri, null, null) } catch (_: Throwable) {}
      path
    }
  }

  private fun writable(values: List<String>): WritableNativeArray =
      WritableNativeArray().apply { values.forEach { pushString(it) } }

  /** Only enough to name a document type; application/octet-stream is legal. */
  private fun guessMime(name: String): String =
      when (name.substringAfterLast('.', "").lowercase()) {
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "heic" -> "image/heic"
        "mp4" -> "video/mp4"
        "mov" -> "video/quicktime"
        "m4v" -> "video/x-m4v"
        "3gp" -> "video/3gpp"
        "mkv" -> "video/x-matroska"
        "mp3" -> "audio/mpeg"
        "pdf" -> "application/pdf"
        "zip" -> "application/zip"
        "txt" -> "text/plain"
        "json" -> "application/json"
        else -> "application/octet-stream"
      }

  /**
   * The type the chooser filters on. The content resolver answers for both
   * branches: FileProvider maps the file extension, and a SAF provider reads
   * the document's stored type. A hardcoded wildcard type here lists every app
   * that accepts any file, so the user picks from a wall of unrelated apps. The
   * wildcard is the fallback only when no provider knows the type, because then
   * there is nothing to filter on.
   */
  private fun typeFor(uri: Uri): String =
      reactApplicationContext.contentResolver.getType(uri) ?: "*/*"

  /**
   * ONE resolution of the engine's data dir, matched by CONSTRUCTION to
   * `File(reactApplicationContext.filesDir, "daak")` in DaakModule.kt's
   * start(). Keep them in step: a second copy of this expression is exactly how
   * this module came to disagree with the engine about where files are.
   */
  private fun dataDir() = File(reactApplicationContext.filesDir, "daak")
}
