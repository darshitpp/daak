package dev.darshit.daak.bgsched

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Keeps the Daak process alive while the Rust outbox is delivering.
 *
 * It raises a low-importance dataSync notification. It also calls the ONE
 * engine wake, DaakWake.wake, when the Daak module has a live engine in this
 * process. It does NOT drain: the outbox worker spawned by Engine::start owns
 * a 5s ticker and is poked on every enqueue and on peer presence. The service
 * has no transport and no crypto in it.
 *
 * ponytail: the service stops only when JS says a transfer finished. A process
 * killed without stopForegroundSync leaves a stale notification; upgrading to a
 * self-terminating watch on the transfer row is the move if that is ever seen.
 */
class DaakSyncService : Service() {
  companion object {
    const val CHANNEL = "daak.transfers"
    const val NOTIF_ID = 41
    const val EXTRA_LABEL = "label"
    private const val TAG = "DaakSyncService"

    /** The one entry point: the module and the worker both go through here. */
    fun start(context: Context, label: String) {
      // The OS throttles a foreground-service start from the background, but a
      // thrown IllegalStateException here would take down whatever called it --
      // a WorkManager worker, or the engine event handler. Log and move on: the
      // outbox still retries on its own ticker without the process being held.
      try {
        context.startForegroundService(
            Intent(context, DaakSyncService::class.java).putExtra(EXTRA_LABEL, label))
      } catch (t: Throwable) {
        Log.w(TAG, "cannot start the transfer foreground service", t)
      }
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Wake the shared outbox worker now. No-op when the module has no live
    // engine in this process.
    DaakWake.wake?.invoke()
    val nm = getSystemService(NotificationManager::class.java)
    // R34: the channel must EXIST before startForeground on API 26+, or the
    // notification is silently dropped and startForeground throws. Idempotent:
    // re-creating an existing channel leaves the user's own importance choice
    // alone.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL) == null) {
      nm.createNotificationChannel(
          NotificationChannel(CHANNEL, "Active transfers", NotificationManager.IMPORTANCE_LOW))
    }
    val notification: Notification =
        NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle(intent?.getStringExtra(EXTRA_LABEL) ?: "Sending with Daak")
            .setOngoing(true)
            .build()
    try {
      startForeground(NOTIF_ID, notification)
    } catch (t: Throwable) {
      // Missing permission, or the OS refused the promotion. Either way the
      // transfer itself must not die: stopSelf so no foreground state is left
      // half-set, and return to the outbox's own retry.
      Log.w(TAG, "startForeground refused", t)
      stopSelf()
    }
    // START_STICKY: a low-memory kill during a long transfer should come back
    // and keep the notification, not silently resume unnotified.
    return START_STICKY
  }

  override fun onDestroy() {
    // STOP_FOREGROUND_REMOVE, not DETACH: a transfer that ended must take its
    // notification with it, or the tray lies about work still in flight.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION") stopForeground(true)
    }
    super.onDestroy()
  }
}
