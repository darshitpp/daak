package dev.darshit.daak.notify

import android.content.Context
import org.json.JSONObject

/**
 * The one action tapped while no JS was listening.
 *
 * RCTDeviceEventEmitter drops an event nobody is subscribed to, and a tapped
 * notification is exactly that case: the user taps it with the app killed. So
 * the action is written to SharedPreferences and drained by consumePendingAction
 * once JS is up. Last write wins, deliberately: two taps in a row means the
 * user is at the second one now.
 */
internal object NotifyStash {
  private const val FILE = "daak.notify"
  private const val KEY = "pendingAction"

  fun put(ctx: Context, action: String, payload: String) {
    ctx.applicationContext
        .getSharedPreferences(FILE, Context.MODE_PRIVATE)
        .edit()
        .putString(KEY, jsonOf(action, payload))
        .apply()
  }

  /** @return the JSON {@code {action,payload}}, or "" when nothing is stashed. */
  fun take(ctx: Context): String {
    val prefs = ctx.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
    val json = prefs.getString(KEY, "") ?: ""
    // Removed only once read, so a crash between the tap and JS booting replays
    // the action instead of losing it.
    if (json.isNotEmpty()) prefs.edit().remove(KEY).apply()
    return json
  }

  /** org.json escapes; the payload is arbitrary JSON carried as a String. */
  fun jsonOf(action: String, payload: String): String =
      JSONObject().put("action", action).put("payload", payload).toString()
}

