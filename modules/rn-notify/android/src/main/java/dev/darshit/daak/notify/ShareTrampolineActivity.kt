package dev.darshit.daak.notify

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File

/**
 * Brings the app up so a tapped action has a foreground context, and for
 * daak.share builds the OS chooser over the entry's saved paths.
 *
 * R33: this is the SAME sheet DaakShare's present() builds, over the same
 * FileProvider URIs. It has no transport, no crypto and no outbox: sharing a
 * RECEIVED file out of the device is the OS's job. The engine's outbox owns every
 * Daak-to-Daak send, and a notification action is not one.
 *
 * Why an activity at all: a BroadcastReceiver cannot present a chooser, and
 * under the background-start restrictions it cannot bring one up either.
 *
 * ponytail: this chooser is a COPY of the one in DaakShareModule.present (via
 * presentShare). It is duplicated because a BroadcastReceiver runs with no React
 * context and cannot reach the TurboModule -- the only justification, and it
 * is a real one. The cost is that it will DRIFT: FileProvider naming, MIME
 * types, the ClipData/grant-flag handling below all have to be kept in step with
 * DaakShareModule.kt by hand. Upgrade path: give the receiver a
 * context-independent seam (a small static DaakShare.presentFiles(paths), or a
 * pending-share file the module drains) and delete this file. Do not grow it
 * further in the meantime.
 */
class ShareTrampolineActivity : Activity() {
  companion object {
    private const val TAG = "DaakNotify"
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val payload = intent?.getStringExtra(DaakNotifyModule.EXTRA_PAYLOAD) ?: "{}"
    val paths = savedPaths(payload)
    val host = DaakNotifyModule.launchIntent(this)
    if (host == null) {
      // Nothing to launch means no host app for the launch intent; there is
      // nothing this trampoline can do, so do not spin.
      Log.w(TAG, "no launch intent; dropping the trampoline")
      finish()
      return
    }
    host.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    if (paths.isNotEmpty()) {
      // Best-effort: a chooser that cannot be built must not stop the app from
      // coming up, because the stash/reveal still has somewhere to go.
      try {
        startActivity(chooser(paths))
      } catch (t: Throwable) {
        Log.w(TAG, "cannot build the chooser", t)
      }
    }
    startActivity(host)
    // noHistory is set in the manifest, but finish() is still correct: this
    // activity has no UI and must not sit in the back stack.
    finish()
  }

  private fun chooser(paths: List<String>): Intent {
    val uris: ArrayList<Uri> = ArrayList(paths.size)
    for (p in paths) {
      val f = File(p)
      // A path that no longer exists (the user moved it, or the app's cache dir
      // was cleared) must not take down the whole sheet.
      if (!f.exists()) continue
      uris.add(FileProvider.getUriForFile(this, packageName + ".fileprovider", f))
    }
    val send =
        if (uris.size > 1) {
          Intent(Intent.ACTION_SEND_MULTIPLE).apply {
            type = "*/*"
            putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
          }
        } else {
          Intent(Intent.ACTION_SEND).apply {
            type = "*/*"
            if (uris.size == 1) putParcelableExtra(Intent.EXTRA_STREAM, uris[0])
          }
        }
    // Without the grant flag no receiver can read the URIs, and without
    // ClipData many receivers read the grant off the clip instead of the
    // extras -- so both, carrying EVERY uri (AOSP does not migrate
    // EXTRA_STREAM on ACTION_SEND_MULTIPLE).
    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    uris.firstOrNull()?.let { first ->
      val clip = android.content.ClipData.newRawUri(null, first)
      uris.drop(1).forEach { clip.addItem(android.content.ClipData.Item(it)) }
      send.clipData = clip
    }
    return Intent.createChooser(send, "Share via")
  }

  /** @return the entry's saved files, or an empty list for anything unreadable. */
  private fun savedPaths(payload: String): List<String> =
      try {
        val arr = JSONObject(payload).optJSONArray("savedPaths") ?: return emptyList()
        (0 until arr.length()).mapNotNull { arr.optString(it, null) }.filter { it.isNotEmpty() }
      } catch (t: Throwable) {
        Log.w(TAG, "unreadable notification payload", t)
        emptyList()
      }
}
