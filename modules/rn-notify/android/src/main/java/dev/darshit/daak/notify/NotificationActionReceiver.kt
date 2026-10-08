package dev.darshit.daak.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Receives a tapped notification action.
 *
 * R33: it does NOT send. daak.share goes to the OS share sheet; the engine
 * outbox owns every actual send, and a second transport here would be the
 * parallel send path this project exists to avoid. All this does is report
 * WHICH action was tapped and bring the app up, because a receiver cannot put an
 * activity in front and cannot present a chooser.
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

    // Open is EMITTED to JS, so a live app switches to the Inbox tab. Share is
    // NOT: the trampoline presents that sheet natively, and emitting it as well
    // would stack a SECOND sheet on a warm app.
    if (action == DaakNotifyModule.ACTION_OPEN) {
      if (!DaakNotifyModule.emitToJs(action, payload)) {
        // App killed, or JS has not booted: nothing is listening and the event
        // is gone. Stash it instead, and consumePendingAction hands it to JS on
        // the first subscription. A receiver must not block waiting for JS.
        NotifyStash.put(context, action, payload)
      }
    }

    // BOTH ids need this. A BroadcastReceiver cannot put an activity in front,
    // so without it a tapped Open did nothing whenever the app was not already
    // in front, and a tapped Share had no activity to host the chooser.
    try {
      context.startActivity(
          Intent(context, ShareTrampolineActivity::class.java).apply {
            putExtra(DaakNotifyModule.EXTRA_ACTION, action)
            putExtra(DaakNotifyModule.EXTRA_ID, id)
            putExtra(DaakNotifyModule.EXTRA_PAYLOAD, payload)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          })
    } catch (t: Throwable) {
      // A device with nothing that can receive a share, or a background-start
      // restriction. The user tapped and nothing happened; that is a dead end,
      // not a reason to crash a receiver they never see.
      Log.w(TAG, "cannot bring the app up for $id", t)
    }
  }

}
