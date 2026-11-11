package dev.darshit.daak.share

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.ext.SdkExtensions
import android.os.StatFs
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import androidx.core.content.FileProvider
import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID
import kotlin.concurrent.thread
import kotlin.math.ceil
import org.json.JSONArray
import org.json.JSONObject

@ReactModule(name = DaakShareModule.NAME)
class DaakShareModule(private val ctx: ReactApplicationContext) : NativeDaakShareSpec(ctx), ActivityEventListener {
  companion object {
    const val NAME = "DaakShare"
    private const val PICK = 4711
    private const val PICK_FOLDER = 4712
    private const val PICK_MEDIA = 4713
    // The photo picker allows up to 5000 items. The JSON size follows this cap.
    private const val MAX_MEDIA = 5000
    // Room for the file system, on top of the size of one item.
    private const val MATERIALIZE_MARGIN = 1_048_576L
  }

  private var pickPromise: Promise? = null
  private var folderPromise: Promise? = null
  private var mediaPromise: Promise? = null

  /** Why a folder copy stopped. JS reads the reject code and the message. */
  private class FolderPickError(val code: String, message: String) : Exception(message)

  /** One item of the picked tree. `parts` is the path below the picked folder. */
  private class Entry(val uri: Uri, val id: String, val parts: List<String>, val isDir: Boolean, val size: Long)

  init { ctx.addActivityEventListener(this) }

  override fun getName() = NAME

  override fun present(text: String?, urls: ReadableArray?, mime: String?, promise: Promise) {
    val activity = currentActivity ?: return promise.reject("E_NO_ACTIVITY", "no foreground activity")
    val fileUris = (urls?.toArrayList() ?: emptyList<Any>()).map { uriFor(it as String) }
    // The chooser filters on the intent type. An empty mime from the caller
    // means "ask the platform", so resolve each document's own type: a
    // hardcoded wildcard lists every app that accepts any file. When the
    // documents differ, keep the wildcard, because one type would hide every
    // app that accepts only the others.
    val types = fileUris.map { ctx.contentResolver.getType(it) }.distinct()
    val shareType = mime?.takeIf { it.isNotEmpty() } ?: types.singleOrNull() ?: "*/*"
    val intent = if (fileUris.size > 1) {
      Intent(Intent.ACTION_SEND_MULTIPLE).apply {
        type = shareType
        putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(fileUris))
        if (!text.isNullOrEmpty()) putExtra(Intent.EXTRA_TEXT, text)
      }
    } else {
      Intent(Intent.ACTION_SEND).apply {
        type = shareType
        if (fileUris.size == 1) putExtra(Intent.EXTRA_STREAM, fileUris[0])
        if (!text.isNullOrEmpty()) putExtra(Intent.EXTRA_TEXT, text)
      }
    }
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    // Without a ClipData the grant above reaches nobody: many receivers read the
    // URI permission off the clip, not off the intent extras. And it must carry
    // EVERY uri -- AOSP's migrateExtraStreamToClipData does not migrate a
    // ParcelableArrayList EXTRA_STREAM, so on ACTION_SEND_MULTIPLE items 2..N
    // would advertise no grantable URI if only the first were attached.
    fileUris.firstOrNull()?.let { first ->
      val clip = ClipData.newRawUri(null, first)
      fileUris.drop(1).forEach { clip.addItem(ClipData.Item(it)) }
      intent.clipData = clip
    }
    // Since API 24 startActivity can throw, for example
    // TransactionTooLargeException for a large EXTRA_TEXT. An uncaught throw in
    // a @ReactMethod stops a release app, so the call rejects the promise.
    try {
      activity.startActivity(Intent.createChooser(intent, "Share via"))
    } catch (_: Throwable) {
      return promise.reject("E_SHARE", "the share sheet did not open")
    }
    // Resolves when the OS chooser is up, not when a peer accepted anything.
    promise.resolve(null)
  }

  override fun pickDocuments(multiple: Boolean, promise: Promise) {
    val activity = currentActivity ?: return promise.reject("E_NO_ACTIVITY", "no foreground activity")
    pickPromise = promise
    activity.startActivityForResult(
      Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE); type = "*/*"
        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
      }, PICK)
  }

  /**
   * Ask the user for ONE folder. SAF gives a content:// tree and no path, and
   * the engine reads with std::fs. So onActivityResult copies the tree into
   * the app cache and resolves the path of that copy. The grant is not kept,
   * because the copy runs once, at the pick.
   */
  override fun pickFolder(promise: Promise) {
    val activity = currentActivity ?: return promise.reject("E_NO_ACTIVITY", "no foreground activity")
    folderPromise = promise
    try {
      activity.startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), PICK_FOLDER)
    } catch (_: Throwable) {
      // A device with no documents app throws ActivityNotFoundException.
      folderPromise = null
      promise.reject("E_PICK", "the folder picker did not open")
    }
  }

  /**
   * Ask the user for photos and videos. The result holds references only. The
   * system photo picker is the first choice. A device without it uses the
   * document picker. See materialize for the copy.
   */
  override fun pickMedia(promise: Promise) {
    val activity = currentActivity ?: return promise.reject("E_NO_ACTIVITY", "no foreground activity")
    val intent = if (isPhotoPickerAvailable(activity)) {
      Intent(MediaStore.ACTION_PICK_IMAGES).apply {
        putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, MediaStore.getPickImagesMaxLimit())
      }
    } else {
      Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = "*/*"
        putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("image/*", "video/*"))
        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
      }
    }
    mediaPromise = promise
    try {
      activity.startActivityForResult(intent, PICK_MEDIA)
    } catch (_: Throwable) {
      mediaPromise = null
      promise.reject("E_PICK", "the media picker did not open")
    }
  }

  @android.annotation.SuppressLint("NewApi")
  private fun isPhotoPickerAvailable(activity: Activity): Boolean {
    val ok = Build.VERSION.SDK_INT >= 33 ||
      (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
        SdkExtensions.getExtensionVersion(Build.VERSION_CODES.R) >= 2)
    return ok && Intent(MediaStore.ACTION_PICK_IMAGES).resolveActivity(activity.packageManager) != null
  }

  /** Copy ONE picked item into the send cache. See materializeToSlot. */
  override fun materialize(token: String, promise: Promise) {
    // The copy can take minutes. It must not block the main thread.
    thread(name = "daak-materialize") {
      try {
        promise.resolve(materializeToSlot(token).absolutePath)
      } catch (e: FolderPickError) {
        promise.reject(e.code, e.message)
      } catch (_: Throwable) {
        promise.reject("E_MATERIALIZE", "Daak could not prepare a file for sending.")
      }
    }
  }

  override fun consumePendingInbox(promise: Promise) = promise.resolve(ShareInbox.drainToJson(ctx))

  override fun consumeIntentSends(promise: Promise) =
    promise.resolve(ShareInbox.drainIntentSendsToJson(ctx))

  /**
   * Publishes the peer list. On Android that means the Direct Share dynamic
   * shortcuts. The parser lives in the app module (it owns the drawable), so a
   * bare TurboModule host without that class resolves without syncing instead
   * of crashing the JS call.
   */
  override fun updateShortcutTargets(devicesJson: String, promise: Promise) {
    try {
      val sync = Class.forName("dev.darshit.daak.shortcuts.DirectShareShortcuts")
        .getMethod("sync", android.content.Context::class.java, java.util.List::class.java)
      sync.invoke(null, ctx, parseDevices(devicesJson))
      promise.resolve(null)
    } catch (cnf: ClassNotFoundException) {
      promise.resolve(null)
    } catch (_: Throwable) {
      promise.reject("E_SHORTCUTS", "the share shortcuts did not update")
    }
  }

  // Returns a raw List, not List<Pair<..>>: reflection has no compile-time view
  // of the app module's Kotlin generics, so `List<Pair<String,String>>` erases
  // to List either way. Kotlin sees no unchecked cast here because the built-in
  // map already produces the exact List<Pair<String,String>> type it wants.
  private fun parseDevices(json: String): List<Pair<String, String>> {
    val arr = org.json.JSONArray(json)
    return (0 until arr.length()).map {
      val o = arr.getJSONObject(it)
      // Reflection cannot construct DirectShareShortcuts.PairedDevice without
      // compile-time knowledge of the class, so the app-side sync takes a plain
      // List<Pair<String,String>> instead. One shape, one parser, one place.
      o.getString("deviceId") to o.getString("name")
    }
  }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode == PICK_FOLDER) {
      val promise = folderPromise ?: return
      folderPromise = null
      val tree = if (resultCode == Activity.RESULT_OK) data?.data else null
      // Cancel starts no copy, so nothing is on disk to delete.
      if (tree == null) return promise.resolve(null)
      // The copy can take minutes. It must not block the main thread.
      thread(name = "daak-pick-folder") {
        try {
          promise.resolve(copyPickedFolder(tree).absolutePath)
        } catch (e: FolderPickError) {
          promise.reject(e.code, e.message)
        } catch (t: Throwable) {
          android.util.Log.w("DaakShare", "E_COPY: the picked folder could not be copied: ${t.javaClass.simpleName}")
          promise.reject("E_COPY", "the folder could not be copied")
        }
      }
      return
    }
    if (requestCode == PICK_MEDIA) {
      val promise = mediaPromise ?: return
      mediaPromise = null
      val uris = mutableListOf<Uri>()
      if (resultCode == Activity.RESULT_OK && data != null) {
        val clip = data.clipData
        if (clip != null) {
          for (i in 0 until minOf(clip.itemCount, MAX_MEDIA)) uris.add(clip.getItemAt(i).uri)
        } else {
          data.data?.let { uris.add(it) }
        }
      }
      if (uris.isEmpty()) return promise.resolve("[]")
      thread(name = "daak-pick-media") {
        try {
          promise.resolve(describePicked(uris))
        } catch (_: Throwable) {
          promise.reject("E_PICK", "the media selection could not be read")
        }
      }
      return
    }
    if (requestCode != PICK) return
    val promise = pickPromise ?: return
    pickPromise = null
    val out = Arguments.createArray()
    if (resultCode == Activity.RESULT_OK && data != null) {
      val clip = data.clipData
      if (clip != null) {
        for (i in 0 until clip.itemCount) out.pushString(ShareInbox.copyToCache(ctx, clip.getItemAt(i).uri).absolutePath)
      } else {
        data.data?.let { out.pushString(ShareInbox.copyToCache(ctx, it).absolutePath) }
      }
    }
    promise.resolve(out)
  }

  override fun onNewIntent(intent: Intent) = Unit

  /**
   * Copy the picked tree into `<cacheDir>/daak-send/<uuid>/<folder name>`.
   * The copy streams file by file. No file goes into memory. Any failure
   * deletes the slot. DaakFsPathsModule.pickedCopiesRoot names the same
   * folder: keep the two equal.
   */
  private fun copyPickedFolder(tree: Uri): File {
    val rootId = DocumentsContract.getTreeDocumentId(tree)
    val name = safeName(queryName(DocumentsContract.buildDocumentUriUsingTree(tree, rootId)) ?: "folder")
    val slot = File(File(ctx.cacheDir, "daak-send"), UUID.randomUUID().toString())
    val dest = File(slot, name)
    try {
      val entries = mutableListOf<Entry>()
      listTree(tree, rootId, emptyList(), entries)
      val files = entries.filter { !it.isDir }
      if (files.isEmpty()) throw FolderPickError("EMPTY", "EMPTY")
      val needed = ceil(files.sumOf { it.size } * 1.1).toLong()
      requireSpace(needed)
      if (!dest.mkdirs()) throw IOException("could not make the copy folder")
      // listTree puts each folder before its contents, so a parent exists.
      for (entry in entries) {
        val target = entry.parts.fold(dest) { dir, part -> File(dir, part) }
        if (entry.isDir) {
          // listTree adds each folder once. A folder that exists is a second
          // folder with the same name, and the two must not merge in silence.
          if (target.exists()) throw FolderPickError("E_COPY", "two folders have the same name")
          if (!target.mkdirs()) throw IOException("could not make a folder")
          continue
        }
        // Some providers allow two items with one name. The second copy must
        // not replace the first in silence.
        if (target.exists()) throw IOException("two items have the name ${entry.parts.last()}")
        val input = ctx.contentResolver.openInputStream(entry.uri)
          ?: throw IOException("could not open ${entry.parts.last()}")
        input.use { i -> FileOutputStream(target).use { o -> i.copyTo(o) } }
      }
      return dest
    } catch (t: Throwable) {
      slot.deleteRecursively()
      throw t
    }
  }

  /** Throws NO_SPACE when the cache has less than `needed` bytes free. */
  private fun requireSpace(needed: Long) {
    if (StatFs(ctx.cacheDir.path).availableBytes < needed) {
      throw FolderPickError("NO_SPACE", "NO_SPACE:$needed")
    }
  }

  /**
   * Build the JSON text for the picked URIs: one token, one name, and one size
   * each. The size is null when the provider gives none. Nothing is copied.
   * The picker grant ends when the app stops, so each URI gets a persistable
   * grant. A failure of that call is ignored.
   */
  private fun describePicked(uris: List<Uri>): String {
    val out = JSONArray()
    for (uri in uris) {
      try {
        ctx.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
      } catch (_: Throwable) {
        // Some providers give no persistable grant. The pick still works now.
      }
      val (name, size) = queryNameAndSize(uri)
      out.put(JSONObject()
        .put("token", uri.toString())
        .put("name", name ?: "media")
        .put("size", size ?: JSONObject.NULL))
    }
    return out.toString()
  }

  /** The display name and the size of one URI. Each is null when missing. */
  private fun queryNameAndSize(uri: Uri): Pair<String?, Long?> {
    val picker = Build.VERSION.SDK_INT >= 33 && uri.authority == MediaStore.AUTHORITY
    val nameCol = if (picker) MediaStore.PickerMediaColumns.DISPLAY_NAME else OpenableColumns.DISPLAY_NAME
    val sizeCol = if (picker) MediaStore.PickerMediaColumns.SIZE else OpenableColumns.SIZE
    return try {
      ctx.contentResolver.query(uri, arrayOf(nameCol, sizeCol), null, null, null)?.use { c ->
        if (!c.moveToFirst()) return@use null to null
        val name = if (c.isNull(0)) null else c.getString(0)
        val size = if (c.isNull(1)) null else c.getLong(1).takeIf { it >= 0 }
        name to size
      } ?: (null to null)
    } catch (_: Throwable) {
      null to null
    }
  }

  /**
   * A picker URI opens as a file descriptor. The Android docs name
   * MediaStore.openFileDescriptor, but API 35 has no such method. The resolver
   * call is the real one. Any other URI opens as a stream.
   */
  private fun openSource(uri: Uri): java.io.InputStream? {
    if (Build.VERSION.SDK_INT >= 33 && uri.authority == MediaStore.AUTHORITY) {
      val fd = ctx.contentResolver.openFileDescriptor(uri, "r") ?: return null
      return android.os.ParcelFileDescriptor.AutoCloseInputStream(fd)
    }
    return ctx.contentResolver.openInputStream(uri)
  }

  /**
   * Copy one picked item into `<cacheDir>/daak-send/<uuid>/<cleaned name>`.
   * DaakFsPathsModule.discardPickedCopy and the startup sweep use the same
   * folder. Any failure deletes the whole slot, so no partial file stays.
   */
  private fun materializeToSlot(token: String): File {
    val uri = Uri.parse(token)
    ShareInbox.requireForeignContentUri(ctx, uri)
    val (name, size) = queryNameAndSize(uri)
    // An unknown size skips the check. A full disk then fails in the copy.
    if (size != null) requireSpace(size + MATERIALIZE_MARGIN)
    val slot = File(File(ctx.cacheDir, "daak-send"), UUID.randomUUID().toString())
    try {
      if (!slot.mkdirs()) throw IOException("could not make the copy folder")
      val out = File(slot, ShareInbox.safeLeaf(name ?: "media"))
      val input = openSource(uri) ?: throw FileNotFoundException("no stream")
      input.use { i ->
        FileOutputStream(out).use { o ->
          val buffer = ByteArray(64 * 1024)
          while (true) {
            val n = i.read(buffer)
            if (n < 0) break
            o.write(buffer, 0, n)
          }
        }
      }
      return out
    } catch (t: Throwable) {
      slot.deleteRecursively()
      if (t is SecurityException || t is FileNotFoundException) {
        throw FolderPickError("E_SOURCE_GONE", "E_SOURCE_GONE")
      }
      throw t
    }
  }

  /**
   * List every folder and file below the tree document `parentId`. Hidden
   * files are included. SAF has no symlink type, so no symlink can occur. An
   * unreadable folder throws, so a copy never misses files in silence.
   *
   * The iOS iCloud placeholder rule has no Android equivalent. A cloud
   * provider gives the bytes through openInputStream, or that call fails and
   * the copy fails.
   */
  private fun listTree(tree: Uri, parentId: String, parts: List<String>, out: MutableList<Entry>) {
    val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId)
    val columns = arrayOf(
      Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE)
    val found: List<Entry> = ctx.contentResolver.query(children, columns, null, null, null)?.use { c ->
      buildList<Entry> {
        while (c.moveToNext()) {
          val id = c.getString(0)
          add(Entry(
            uri = DocumentsContract.buildDocumentUriUsingTree(tree, id),
            id = id,
            parts = parts + safeName(c.getString(1) ?: ""),
            isDir = c.getString(2) == Document.MIME_TYPE_DIR,
            // A provider can omit the size. The space check then counts 0.
            size = if (c.isNull(3)) 0L else c.getLong(3)))
        }
      }
    } ?: throw IOException("could not list a folder in the tree")
    for (entry in found) {
      out.add(entry)
      if (entry.isDir) listTree(tree, entry.id, entry.parts, out)
    }
  }

  /** The display name of one document, or null when the provider gives none. */
  private fun queryName(doc: Uri): String? =
    ctx.contentResolver.query(doc, arrayOf(Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { c ->
      if (c.moveToFirst()) c.getString(0) else null
    }

  /**
   * A display name comes from the provider. It must be one path part, or the
   * copy can write outside the slot. A bad name stops the whole copy.
   */
  private fun safeName(name: String): String {
    if (name.isEmpty() || name == "." || name == ".." || name.contains('/') || name.contains('\u0000')) {
      throw IOException("the folder holds an item with a name that is not valid")
    }
    return name
  }

  private fun uriFor(path: String): Uri =
    if (path.startsWith("content://")) {
      // The download-folder move recorded a SAF document URI, and the app holds
      // the persisted tree grant. FileProvider cannot build a URI for a path
      // that is not a file: it THROWS, present() rejects, and the JS share verb
      // swallows the rejection, so the Share button looks dead. Pass the URI
      // through and let the intent's read flag grant it to the receiver.
      Uri.parse(path)
    } else {
      FileProvider.getUriForFile(ctx, ctx.packageName + ".fileprovider", File(path))
    }

  override fun addListener(eventName: String) = Unit
  override fun removeListeners(count: Double) = Unit
}
