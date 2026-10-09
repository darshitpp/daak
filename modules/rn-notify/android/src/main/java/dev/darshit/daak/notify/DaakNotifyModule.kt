package dev.darshit.daak.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.util.Log
import android.webkit.MimeTypeMap
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

private const val EVENT = "DaakNotifyEvent"
private const val PERM_REQUEST_CODE = 0x0DA6
private const val POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS"
private const val TAG = "DaakNotify"
/** The short side of the banner thumbnail, in pixels. */
private const val THUMB_PX = 512

@ReactModule(name = DaakNotifyModule.NAME)
class DaakNotifyModule(private val ctx: ReactApplicationContext) : NativeDaakNotifySpec(ctx) {
  companion object {
    const val NAME = "DaakNotify"
    const val CHANNEL = "daak.received"

    const val ACTION_OPEN = "daak.open"
    const val ACTION_SHARE = "daak.share"
    // R37: part of the FROZEN vocabulary, deliberately NOT installed. reveal
    // has no implementation on either platform, so a button that does nothing
    // is worse than no button. DAK_REGISTERED_ACTIONS in notify.ts and the iOS
    // actionTitles table withhold it the same way.
    const val ACTION_FOLDER = "daak.folder"

    const val EXTRA_ACTION = "dev.darshit.daak.notify.action"
    const val EXTRA_ID = "dev.darshit.daak.notify.id"
    const val EXTRA_PAYLOAD = "dev.darshit.daak.notify.payload"

    /**
     * The live React context, or null when the app is not running. Set in the
     * constructor and CLEARED in invalidate(): a stale static context outliving
     * the bridge leaks the whole React instance and emits into nothing.
     */
    @Volatile private var reactContext: ReactApplicationContext? = null

    /**
     * How many JS listeners the Spec's addListener has registered.
     *
     * reactContext alone is NOT a delivery signal: it is non-null from the
     * moment the module is constructed, which is before JS subscribes. Gating
     * on it alone reports `true` for an emit that lands in nothing, so the
     * tapped action is silently lost instead of stashed -- the same class of
     * defect the stash exists for. The count is the gate.
     */
    @Volatile private var listenerCount = 0

    /**
     * The host app's launcher activity, found by intent rather than by class
     * name: this library cannot see the app's MainActivity at compile time, and
     * a hardcoded class string is a ClassNotFoundException the moment either is
     * renamed.
     */
    fun launchIntent(context: Context): Intent? =
        context.packageManager.getLaunchIntentForPackage(context.packageName)

    /**
     * Emits the tapped action to JS, or returns false when no bridge is
     * listening so the caller can stash it instead. Never throws: this runs
     * inside a BroadcastReceiver the user never sees, where a crash is a dead
     * end with no visible cause.
     */
    fun emitToJs(action: String, payload: String): Boolean {
      if (listenerCount > 0) {
        val rc = reactContext
        if (rc != null) {
          return try {
            rc.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(EVENT, Arguments.createMap().apply {
                  putString("action", action)
                  putString("payload", payload)
                })
            true
          } catch (t: Throwable) {
            Log.w(TAG, "cannot emit action event", t)
            false
          }
        }
      }
      // No listener, or no live bridge: report false so the caller stashes.
      return false
    }

    /**
     * R34: on API 31+ an IMMUTABLE-or-MUTABLE PendingIntent is MANDATORY -- an
     * implicit one throws IllegalArgumentException. minSdk is 24, so this needs
     * the version guard. IMMUTABLE is the correct value: nothing fills any of
     * these intents in after creation, and a mutable one would let a holder
     * rewrite the payload of a notification the user was shown.
     *
     * Pre-S the flag does not exist and 0 IS the pre-M default, so one call site
     * covers every supported API level.
     */
    val IMMUTABLE: Int
      get() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_IMMUTABLE else 0
  }

  private var pendingPermission: Promise? = null

  private val permissionListener = PermissionListener { _, _, grantResults ->
    val promise = pendingPermission
    pendingPermission = null
    promise?.resolve(
        grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED)
    true
  }

  init {
    reactContext = ctx
  }

  override fun getName() = NAME

  override fun invalidate() {
    // The counter is static too, so clearing only the context leaves it above
    // zero after a dev-bridge reload: the new instance adds fresh listeners on
    // top, and emitToJs claims delivery into the torn-down context it no longer
    // has. The action is then neither emitted nor stashed.
    if (reactContext === ctx) {
      reactContext = null
      listenerCount = 0
    }
    super.invalidate()
  }

  /**
   * R34: on API 33+ POST_NOTIFICATIONS is a RUNTIME permission, so
   * areNotificationsEnabled() alone is a status QUERY, never a request -- the
   * brief's version would report false forever and the user would never be
   * asked. This asks for real, from a foreground activity (the only context that
   * can prompt), and hands the ANSWER back to JS.
   *
   * Below API 33 there is no runtime gate at all: notifications are on unless
   * the user turned them off in settings, which areNotificationsEnabled() does
   * report, so there is nothing to request.
   */
  override fun requestPermission(promise: Promise) {
    if (notificationsEnabled()) {
      promise.resolve(true)
      return
    }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
      promise.resolve(false)
      return
    }
    val activity = currentActivity
    if (activity !is PermissionAwareActivity) {
      // No foreground activity, so there is nothing to prompt from. false is the
      // honest answer (R36), not a rejection that would break app startup.
      promise.resolve(false)
      return
    }
    pendingPermission = promise
    try {
      activity.requestPermissions(arrayOf(POST_NOTIFICATIONS), PERM_REQUEST_CODE, permissionListener)
    } catch (t: Throwable) {
      pendingPermission = null
      Log.w(TAG, "requestPermissions failed", t)
      promise.resolve(false)
    }
  }

  private fun notificationsEnabled(): Boolean =
      NotificationManagerCompat.from(ctx).areNotificationsEnabled()

  /**
   * R34: the channel must EXIST before posting on API 26+, or the post is
   * silently dropped. Idempotent: createNotificationChannel on an existing id
   * updates it and leaves the user's own importance choice alone.
   */
  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = ctx.getSystemService(NotificationManager::class.java)
    if (nm.getNotificationChannel(CHANNEL) == null) {
      nm.createNotificationChannel(
          NotificationChannel(CHANNEL, "Received files", NotificationManager.IMPORTANCE_DEFAULT))
    }
  }

  override fun registerCategories(categoriesJson: String, promise: Promise) {
    // Android action buttons are per-notification, not per-category, so the
    // channel is the only thing to install here. The JSON is still parsed so a
    // malformed caller is loud at registration rather than at every post.
    ensureChannel()
    try {
      JSONArray(categoriesJson)
    } catch (t: Throwable) {
      promise.reject("E_NOTIFY", "categoriesJson is not a JSON array", t)
      return
    }
    promise.resolve(null)
  }

  override fun post(id: String, title: String, body: String, category: String, payloadJson: String, promise: Promise) {
    // R36: no permission means no banner, not a broken receive. Resolving rather
    // than rejecting is what keeps a denied permission off the inbox path.
    if (!notificationsEnabled()) {
      promise.resolve(null)
      return
    }
    ensureChannel()
    val notification = NotificationCompat.Builder(ctx, category.ifEmpty { CHANNEL })
        .setSmallIcon(android.R.drawable.stat_sys_download_done)
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(NotificationCompat.BigTextStyle().bigText(body))
        .setAutoCancel(true)
        // NO action buttons. Open did nothing whenever the app was not already
        // in front, and Share built a URI for a path the download-folder move
        // had deleted. A button is a promise, so both are withheld until they
        // keep it. The BODY tap keeps the one useful verb: land on the Inbox.
        // The tap launches ShareTrampolineActivity directly. A receiver that a
        // notification tap triggers cannot start an activity when the app
        // targets Android 12 or higher (notification trampoline restriction).
        // The activity brings the app up and delivers the open event, which the
        // shell turns into the Inbox tab. R33 still holds: nothing here sends.
        //
        // setContentIntent is a BUILDER method, so it has to run before
        // build(). It was once called on the Notification build() returns, where
        // contentIntent is only a public field: the call went nowhere and a
        // body tap did nothing at all. A request code per id keeps two posts
        // from sharing one PendingIntent.
        .setContentIntent(openPending(id, payloadJson))
        .apply {
          // A preview thumbnail for the first image the entry saved, when there
          // is one. Best-effort: a banner must never fail the receive.
          thumbnailOf(payloadJson)?.let { setLargeIcon(it) }
        }
        .build()
    try {
      NotificationManagerCompat.from(ctx).notify(id.hashCode(), notification)
    } catch (t: Throwable) {
      // A SecurityException when an OEM lies about the grant, and a dead
      // NotificationManager: neither may take down a receive.
      Log.w(TAG, "notify failed", t)
    }
    promise.resolve(null)
  }

  override fun cancel(id: String, promise: Promise) {
    NotificationManagerCompat.from(ctx).cancel(id.hashCode())
    promise.resolve(null)
  }

  /**
   * The stash is drained once, by whoever subscribes first. A notification is
   * the one event that can fire with no listener, so without this a user who
   * taps an action with the app killed sees nothing happen at all.
   */
  override fun consumePendingAction(promise: Promise) = promise.resolve(NotifyStash.take(ctx))

  // The body tap launches an activity directly. A receiver that a notification
  // tap triggers cannot start an activity when the app targets Android 12 or
  // higher. The old broadcast route therefore left the app closed.
  private fun openPending(id: String, payload: String): PendingIntent {
    val intent = Intent(ctx, ShareTrampolineActivity::class.java).apply {
      action = ACTION_OPEN
      putExtra(EXTRA_ACTION, ACTION_OPEN)
      putExtra(EXTRA_ID, id)
      putExtra(EXTRA_PAYLOAD, payload)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    return PendingIntent.getActivity(ctx, (id + ":" + ACTION_OPEN).hashCode(), intent, IMMUTABLE)
  }

  private fun actionPending(id: String, action: String, payload: String): PendingIntent {
    val intent = Intent(ctx, NotificationActionReceiver::class.java).apply {
      this.action = action
      putExtra(EXTRA_ACTION, action)
      putExtra(EXTRA_ID, id)
      putExtra(EXTRA_PAYLOAD, payload)
    }
    return PendingIntent.getBroadcast(ctx, (id + ":" + action).hashCode(), intent, IMMUTABLE)
  }

  /**
   * A small preview of the first image the entry saved, or null.
   *
   * Best-effort: a banner must never fail the receive, so every failure here is
   * swallowed. The decode is DOWNSAMPLED before the bitmap is allocated,
   * because a modern phone photo decoded at full size is tens of megabytes and
   * this runs on the receive path.
   */
  private fun thumbnailOf(payloadJson: String): Bitmap? =
      try {
        val arr = JSONObject(payloadJson).optJSONArray("savedPaths")
        val path =
            (0 until (arr?.length() ?: 0))
                .mapNotNull { arr?.optString(it, null) }
                .firstOrNull { mimeFor(it)?.startsWith("image/") == true }
        if (path == null) null else decodeThumb(path)
      } catch (t: Throwable) {
        Log.w(TAG, "no thumbnail", t)
        null
      }

  /**
   * The type of a saved document. A content:// path carries its type in the
   * provider; a filesystem path carries it in the file extension.
   */
  private fun mimeFor(path: String): String? =
      if (path.startsWith("content://")) {
        ctx.contentResolver.getType(Uri.parse(path))
      } else {
        MimeTypeMap.getSingleton()
            .getMimeTypeFromExtension(path.substringAfterLast('.', "").lowercase())
      }

  /**
   * Decode a bitmap downsampled so that BOTH sides stay at or above THUMB_PX.
   * The short side therefore lands in [THUMB_PX, 2 * THUMB_PX), which bounds
   * the bitmap without turning it into a postage stamp.
   */
  private fun decodeThumb(path: String): Bitmap? {
    val uri = if (path.startsWith("content://")) Uri.parse(path) else Uri.fromFile(File(path))
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    ctx.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    val opts =
        BitmapFactory.Options().apply {
          inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, THUMB_PX)
        }
    return ctx.contentResolver.openInputStream(uri)?.use {
      BitmapFactory.decodeStream(it, null, opts)
    }
  }

  /** The largest power of two that keeps both sides at or above the target. */
  private fun sampleSize(width: Int, height: Int, target: Int): Int {
    var s = 1
    while (width / (s * 2) >= target && height / (s * 2) >= target) s *= 2
    return s
  }

  override fun addListener(eventName: String) {
    listenerCount++
  }

  override fun removeListeners(count: Double) {
    listenerCount = (listenerCount - count.toInt()).coerceAtLeast(0)
  }
}
