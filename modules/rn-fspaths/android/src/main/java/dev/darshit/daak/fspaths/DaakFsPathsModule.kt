package dev.darshit.daak.fspaths

import android.content.Intent
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule
import java.io.File

@ReactModule(name = DaakFsPathsModule.NAME)
class DaakFsPathsModule(reactContext: ReactApplicationContext) :
    NativeDaakFsPathsSpec(reactContext) {

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
  }

  override fun getName() = NAME

  /**
   * filesDir, and deliberately NOT getExternalFilesDir(DIRECTORY_DOCUMENTS):
   * both are inside the sandbox, and filesDir is what the engine's data dir
   * already uses, so one root holds the database, the keys and every saved
   * file. Android's own Downloads dir is not app-writable without
   * MANAGE_EXTERNAL_STORAGE, which a LAN file app has no business asking for.
   */
  @ReactMethod
  override fun documentsDir(promise: Promise) = resolve(promise) { reactApplicationContext.filesDir.absolutePath }

  /**
   * Android HAS a per-app external downloads dir, and it is still inside the
   * sandbox (app-specific external storage needs no permission), so this is a
 * real directory rather than a lie. It is null only while external storage is
   * unmounted, and then filesDir is the honest fallback.
   */
  @ReactMethod
  override fun downloadsDir(promise: Promise) = resolve(promise) {
    (reactApplicationContext.getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS)
        ?: reactApplicationContext.filesDir).absolutePath
  }

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
    val file = File(path)
    if (!file.exists()) return@resolve false
    val uri = FileProvider.getUriForFile(reactApplicationContext, AUTHORITY, file)
    val intent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, "*/*")
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

  private inline fun resolve(promise: Promise, block: () -> Any?) {
    try { promise.resolve(block()) } catch (t: Throwable) { promise.reject("E_FSPATHS", t) }
  }
}
