package dev.darshit.daak.bgsched

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The ONE engine-wake slot the Android background triggers reach.
 *
 * The engine lives in the Daak ReactModule. That module installs a wake
 * closure here once the engine is up and clears it on shutdown. A worker or a
 * service that runs with no live module finds a null slot and does nothing,
 * because the engine's own outbox ticker still drains on a later launch.
 */
object DaakWake {
  @Volatile var wake: (() -> Unit)? = null
}

/**
 * The Android background wake.
 *
 * It does TWO things and no more. First, it calls the ONE engine wake,
 * DaakWake.wake, when the Daak module has a live engine in this process. Then
 * it re-raises the foreground service IF a transfer is in flight.
 *
 * It does NOT drain. The Rust outbox worker has its own 5s ticker. The worker
 * is poked on every enqueue and on peer presence. A queued row is therefore
 * delivered on reconnect with nobody asking.
 *
 * isTransferActive() is a shared-preference probe, not an engine query:
 * WorkManager runs in a process that may not have a live engine. The module
 * writes the flag from the same foreground start/stop calls the transfer
 * events already drive.
 *
 * Result.success() always: a failed retry here would reschedule the same probe
 * in a tight loop and burn battery for no information.
 */
class DaakDrainWorker(context: Context, params: WorkerParameters) :
    CoroutineWorker(context, params) {
  override suspend fun doWork(): Result =
      withContext(Dispatchers.IO) {
        try {
          // Wake the shared outbox worker now. No-op when the module has no
          // live engine in this process.
          DaakWake.wake?.invoke()
          if (isTransferActive()) {
            DaakSyncService.start(applicationContext, "Sending with Daak")
          }
        } catch (t: Throwable) {
          Log.w("DaakDrainWorker", "background wake failed", t)
        }
        Result.success()
      }

  companion object {
    private const val PREFS = "daak.bgsched"
    private const val KEY_TRANSFER_ACTIVE = "transfer-active"

    /** Written by the module when it starts/stops the service. */
    fun setTransferActive(context: Context, active: Boolean) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
          .edit()
          .putBoolean(KEY_TRANSFER_ACTIVE, active)
          .commit()
    }

    fun isTransferActive(): Boolean {
      // No context here on purpose: the module supplies the probe as a lambda
      // so the worker cannot construct a second one. See the module.
      return activeProbe?.invoke() ?: false
    }

    // Replaced once by DaakBgSchedModule at construction with a probe bound to
    // the module's context. A null probe answers false, which is the safe
    // answer: no service, no notification, no work.
    @Volatile private var activeProbe: (() -> Boolean)? = null

    fun installProbe(probe: () -> Boolean) {
      activeProbe = probe
    }
  }
}
