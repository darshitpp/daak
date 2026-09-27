package dev.darshit.daak.clipboard

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Handler
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule

@ReactModule(name = DaakClipboardModule.NAME)
class DaakClipboardModule(reactContext: ReactApplicationContext) :
    NativeDaakClipboardSpec(reactContext) {

  companion object { const val NAME = "DaakClipboard" }

  override fun getName() = NAME

  // ClipboardManager must be touched on a thread with a Looper, and the engine
  // event handler has none, so this hops to the main thread rather than
  // threading a Handler through the call site.
  @ReactMethod
  override fun setString(text: String, promise: Promise) = onMain(promise) {
    clipboard().setPrimaryClip(ClipData.newPlainText("daak", text))
    promise.resolve(true)
  }

  @ReactMethod
  override fun getString(promise: Promise) = onMain(promise) {
    val clip = clipboard().primaryClip
    promise.resolve(
        if (clip != null && clip.itemCount > 0) {
          clip.getItemAt(0).coerceToText(reactApplicationContext).toString()
        } else {
          ""
        })
  }

  private fun clipboard(): ClipboardManager =
      reactApplicationContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

  private inline fun onMain(promise: Promise, block: () -> Unit) {
    Handler(reactApplicationContext.mainLooper).post {
      try { block() } catch (t: Throwable) { promise.reject("E_CLIPBOARD", t) }
    }
  }
}
