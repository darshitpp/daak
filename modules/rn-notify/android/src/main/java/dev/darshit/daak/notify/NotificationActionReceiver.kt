package dev.darshit.daak.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Receives a tapped notification action.
 *
 * R33: it does NOT send. daak.share goes to the OS share sheet, which is the
 * app's own presentShare path; the engine outbox owns every actual send, and a
 * second transport here would be the parallel send path this project exists to
 * avoid. All this does is report WHICH action was tapped, and for share host the
 * chooser in an activity (a receiver cannot present one).
 */
class NotificationActionReceiver : BroadcastReceiver() {
  companion object {
    private const val TAG = "DaakNotify"

    /** The only three ids this receiver answers to. */
    val ACTIONS = setOf(
        DaakNotifyModule.ACTION_OPEN, DaakNotifyModule.ACTION_SHARE, DaakNotifyModule.ACTION_FOLDER)
  }

  override fun onReceive(context: Context, intent: Intent) {
    // Not a Daak action: the action string doubles as the intent action, and
    // anything else here is another app's broadcast or an OS replay.
    val action = intent.getStringExtra(DaakNotifyModule.EXTRA_ACTION) ?: return
    if (action !in ACTIONS) return
    val payload = intent.getStringExtra(DaakNotifyModule.EXTRA_PAYLOAD) ?: "{}"
    val id = intent.getStringExtra(DaakNotifyModule.EXTRA_ID).orEmpty()

    // Emit first. When JS is alive and subscribed it acts on the event, which is
    // how the share sheet and the reveal both happen.
    if (!DaakNotifyModule.emitToJs(context, action, payload)) {
      // App killed, or JS has not booted: nothing is listening and the event is
      // gone. Stash it instead, and consumePendingAction hands it to JS on the
      // first subscription. A receiver must not block waiting for JS to boot.
      NotifyStash.put(context, action, payload)
    }

    if (action != DaakNotifyModule.ACTION_SHARE) return
    // The chooser can only be started from a foreground activity, and the app
    // may not even be running, so bring it up explicitly.
    try {
      context.startActivity(
          Intent(context, ShareTrampolineActivity::class.java).apply {
            putExtra(DaakNotifyModule.EXTRA_ID, id)
            putExtra(DaakNotifyModule.EXTRA_PAYLOAD, payload)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          })
    } catch (t: Throwable) {
      // A device with nothing that can receive a share, or a background-start
      // restriction. The user tapped Share and nothing happened; that is a dead
      // end, not a reason to crash a receiver they never see.
      Log.w(TAG, "cannot open the share sheet for $id", t)
    }
  }

}
