package dev.darshit.daak.fspaths

import android.content.Intent
import android.app.Activity
import android.content.SharedPreferences
import android.net.Uri
import android.provider.DocumentsContract
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableNativeArray
import com.facebook.react.module.annotations.ReactModule
import java.io.File

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
    const val AUTHORITY = "dev.darshit.daak.fileprovider"

    /** R42p: where the chosen destination folder lives between launches. */
    private const val PREFS = "daak.fspaths"
    private const val KEY_TREE = "downloadFolderTree"
    private const val KEY_NAME = "downloadFolderName"
    private const val REQUEST_TREE = 47011
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
    val uri = FileProvider.getUriForFile(reactApplicationContext, AUTHORITY, file)
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
   * reveal action must not die on an unhandled rejection.
   */
  @ReactMethod
  override fun exists(path: String, promise: Promise) = resolve(promise) { File(path).exists() }

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

  private inline fun resolve(promise: Promise, block: () -> Any?) {
    try { promise.resolve(block()) } catch (t: Throwable) { promise.reject("E_FSPATHS", t) }
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
    } catch (t: Throwable) {
      promise.reject("E_TREE", "could not keep that folder", t)
    }
  }

  override fun onNewIntent(intent: Intent) {}

  @ReactMethod
  override fun downloadFolderName(promise: Promise) =
      // The TREE URI, not the display name: on Android the location of a SAF
      // folder IS the URI, and a bare name would not say where the files go.
      resolve(promise) { prefs().getString(KEY_TREE, null) ?: prefs().getString(KEY_NAME, null) }

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
   */
  @ReactMethod
  override fun moveReceivedFiles(paths: ReadableArray, promise: Promise) = resolve(promise) {
    // The generated spec hands a ReadableArray in and takes a WritableArray
    // back; that is the Android bridge's own shape for string[], and converting
    // to List<String> here would not satisfy the abstract member.
    val input = (0 until paths.size()).mapNotNull { paths.getString(it) }
    val treeUri = prefs().getString(KEY_TREE, null)?.let(Uri::parse)
    if (treeUri == null) return@resolve writable(input)
    val resolver = reactApplicationContext.contentResolver
    val root =
        DocumentsContract.buildDocumentUriUsingTree(
            treeUri, DocumentsContract.getTreeDocumentId(treeUri))
    writable(
        input.map { path ->
      val src = File(path)
      if (!src.exists()) return@map path
      try {
        val dest = DocumentsContract.createDocument(resolver, root, guessMime(src.name), src.name)
        if (dest == null) return@map path
        resolver.openOutputStream(dest)?.use { out ->
          src.inputStream().use { input -> input.copyTo(out) }
        } ?: return@map path
        src.delete()
        dest.toString()
      } catch (t: Throwable) {
        path
      }
        })
  }

  // Task 7 replaces these bodies.
  @ReactMethod
  override fun saveToLibrary(paths: ReadableArray, promise: Promise) = resolve(promise) {
    writable((0 until paths.size()).mapNotNull { paths.getString(it) })
  }

  @ReactMethod
  override fun requestPhotosAccess(promise: Promise) = resolve(promise) { true }

  @ReactMethod
  override fun photosAccessStatus(promise: Promise) = resolve(promise) { "unavailable" }

  private fun writable(values: List<String>): WritableNativeArray =
      WritableNativeArray().apply { values.forEach { pushString(it) } }

  /** Only enough to name a document type; application/octet-stream is legal. */
  private fun guessMime(name: String): String =
      when (name.substringAfterLast('.', "").lowercase()) {
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "mp4" -> "video/mp4"
        "mov" -> "video/quicktime"
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
