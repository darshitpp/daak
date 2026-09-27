package dev.darshit.daak.share

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.widget.Toast
import dev.darshit.daak.MainActivity

/**
 * Inbound share target. Staging ONLY: it copies the shared bytes into
 * filesDir/share-inbox, records the batch metadata ShareInbox owns, wakes the
 * host app and finishes. It never sends, never contacts a peer and does no
 * crypto: the engine outbox owns delivery, so "Queued in Daak" means
 * durably accepted, not delivered.
 */
class ShareTargetActivity : Activity() {
  companion object {
    /** Task 7's Direct Share extra: the device id the sender already chose. */
    private const val EXTRA_TARGET_DEVICE = "daak.target_device"
    private const val TAG = "ShareTarget"
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val intent = intent
    val directSend =
      try {
        when (intent?.action) {
          Intent.ACTION_SEND -> handleSingle(intent)
          Intent.ACTION_SEND_MULTIPLE -> handleMultiple(intent)
          else -> false
        }
      } catch (t: Throwable) {
        // This activity has no UI of its own: an uncaught throw here is a lost
        // share with the user staring at the share sheet wondering why Daak did
        // nothing. Log it, say so, and still open the host.
        Log.w(TAG, "share staging failed", t)
        false
      }
    launchHost(directSend)
  }

  /** @return true when this share already names its destination. */
  private fun handleSingle(intent: Intent): Boolean {
    val text = intent.getStringExtra(Intent.EXTRA_TEXT)
    val stream = streamOf(intent)
    val target = intent.getStringExtra(EXTRA_TARGET_DEVICE)
    if (target.isNullOrEmpty()) {
      if (!text.isNullOrEmpty()) ShareInbox.stageText(this, text)
      stream?.let { stageFile(it, intent.type) }
      return false
    }
    // Direct Share already names the peer, so the text belongs to the
    // intent-send arm and nowhere else. Staging it as a text item as well would
    // show the user the same message twice: once sent, once still queued.
    stream?.let { stageFile(it, intent.type) }
    ShareInbox.stageIntentSend(this, target, text)
    return true
  }

  private fun handleMultiple(intent: Intent): Boolean {
    val text = intent.getStringExtra(Intent.EXTRA_TEXT)
    if (!text.isNullOrEmpty()) ShareInbox.stageText(this, text)
    // One unreadable item must not abandon the rest of the batch: this is a
    // background context with no user standing in front of a crash dialog.
    streamsOf(intent).forEach { runCatching { stageFile(it, intent.type) } }
    return false
  }

  private fun stageFile(uri: Uri, mime: String?) {
    ShareInbox.stageFile(this, ShareInbox.copyToCache(this, uri), mime)
  }

  @Suppress("DEPRECATION")
  private fun streamOf(intent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
      intent.getParcelableExtra(Intent.EXTRA_STREAM)
    }

  @Suppress("DEPRECATION")
  private fun streamsOf(intent: Intent): List<Uri> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) ?: emptyList()
    } else {
      intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM) ?: emptyList()
    }

  private fun launchHost(directSend: Boolean) {
    Toast.makeText(
      this,
      if (directSend) "Queued for send in Daak" else "Queued in Daak",
      Toast.LENGTH_SHORT,
    ).show()
    // MainActivity is a real class in this app, so name it. Class.forName turns
    // a compile-time reference into a runtime string lookup that throws the
    // moment the class is renamed or proguarded away.
    startActivity(
      Intent(this, MainActivity::class.java).apply {
        action = Intent.ACTION_MAIN
        addCategory(Intent.CATEGORY_LAUNCHER)
        // CLEAR_TOP, no NEW_TASK: the target must join the EXISTING Daak task
        // (which is singleTask) instead of stacking a second copy of the app.
        flags = Intent.FLAG_ACTIVITY_CLEAR_TOP
      })
    finish()
  }
}
