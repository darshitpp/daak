package dev.darshit.daak.share

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule
import java.io.File

@ReactModule(name = DaakShareModule.NAME)
class DaakShareModule(private val ctx: ReactApplicationContext) : NativeDaakShareSpec(ctx), ActivityEventListener {
  companion object { const val NAME = "DaakShare"; private const val PICK = 4711 }

  private var pickPromise: Promise? = null

  init { ctx.addActivityEventListener(this) }

  override fun getName() = NAME

  override fun present(text: String?, urls: ReadableArray?, mime: String?, promise: Promise) {
    val activity = currentActivity ?: return promise.reject("E_NO_ACTIVITY", "no foreground activity")
    val fileUris = (urls?.toArrayList() ?: emptyList<Any>()).map { uriFor(activity, it as String) }
    val intent = if (fileUris.size > 1) {
      Intent(Intent.ACTION_SEND_MULTIPLE).apply {
        type = mime?.takeIf { it.isNotEmpty() } ?: "*/*"
        putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(fileUris))
        if (!text.isNullOrEmpty()) putExtra(Intent.EXTRA_TEXT, text)
      }
    } else {
      Intent(Intent.ACTION_SEND).apply {
        type = mime?.takeIf { it.isNotEmpty() } ?: "*/*"
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
    activity.startActivity(Intent.createChooser(intent, "Share via"))
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
    } catch (t: Throwable) {
      promise.reject("E_SHORTCUTS", t)
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

  private fun uriFor(activity: Activity, path: String): Uri =
    FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", File(path))

  override fun addListener(eventName: String) = Unit
  override fun removeListeners(count: Double) = Unit
}
