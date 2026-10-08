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
    val action = intent?.getStringExtra(DaakNotifyModule.EXTRA_ACTION).orEmpty()
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
    // Share builds the chooser; Open only needs the app in front. A chooser on
    // an Open tap would show a share sheet the user did not ask for.
    if (action == DaakNotifyModule.ACTION_SHARE && paths.isNotEmpty()) {
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
      // R42p: the download-folder move records a SAF content:// document URI.
      // File(p) is not a file, so the old exists() guard SKIPPED every moved
      // file and the sheet opened with nothing attached. Pass the URI through;
      // the read flag below grants it to the receiver.
      if (p.startsWith("content://")) {
        uris.add(Uri.parse(p))
        continue
      }
      val f = File(p)
      // A path that no longer exists (the user moved it, or the app's cache dir
      // was cleared) must not take down the whole sheet.
      if (!f.exists()) continue
      uris.add(FileProvider.getUriForFile(this, packageName + ".fileprovider", f))
    }
    // The chooser filters on this type. Ask the resolver for each document's
    // own type, and keep the wildcard when the documents differ, because one
    // type would hide every app that accepts only the others. The same rule
    // DaakShareModule.present applies; keep the two in step.
    val types = uris.map { contentResolver.getType(it) }.distinct()
    val shareType = types.singleOrNull() ?: "*/*"
    val send =
        if (uris.size > 1) {
          Intent(Intent.ACTION_SEND_MULTIPLE).apply {
            type = shareType
            // putParcelableArrayListExtra takes a CONCRETE java.util.ArrayList,
            // not a kotlin.collections.List. `uris` is already an ArrayList, so
            // this needs no copy.
            putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
          }
        } else {
          Intent(Intent.ACTION_SEND).apply {
            type = shareType
            // There is no putParcelableExtra on Intent: the single-item
            // Parcelable overload is putExtra(String, Parcelable). The
            // ARRAY-LIST form one branch up IS a distinct method, which is why
            // only this one looked plausible.
            if (uris.size == 1) putExtra(Intent.EXTRA_STREAM, uris[0])
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
  // A BLOCK body, not an expression body: the `?: return emptyList()` below is a
  // return out of savedPaths, which Kotlin forbids in an expression-bodied fun.
  private fun savedPaths(payload: String): List<String> {
    try {
      val arr = JSONObject(payload).optJSONArray("savedPaths") ?: return emptyList()
      return (0 until arr.length()).mapNotNull { arr.optString(it, null) }.filter { it.isNotEmpty() }
    } catch (t: Throwable) {
      Log.w(TAG, "unreadable notification payload", t)
      return emptyList()
    }
  }
}
