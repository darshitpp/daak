package dev.darshit.daak.bgsched

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The Android background wake. It does NOT drain anything (GAP 1).
 *
 * The plan's version calls a shared engine holder's drain from here; no such
 * class exists in this repo and never has, and the engine has no drain entry
 * point at all. What actually needs doing on a background slot is to re-raise
 * the foreground service IF a transfer is in flight, because that is the only
 * thing a background slot can do that the process was not already doing. The
 * outbox's own 5s ticker drains the queue; enqueue_outbox_send and
 * notify_peer_online poke it the moment a peer appears.
 *
 * isTransferActive() is deliberately a shared-preference probe rather than a
 * query into the engine: WorkManager runs in a process that may not have a live
 * engine, and reaching one from a worker is the exact coupling the plan's
 * version assumed. The module writes the flag from the same foreground
 * start/stop calls the transfer events already drive.
 *
 * Result.success() always: a failed retry here would reschedule the same probe
 * in a tight loop and burn battery for no information.
 */
class DaakDrainWorker(context: Context, params: WorkerParameters) :
    CoroutineWorker(context, params) {
  override suspend fun doWork(): Result =
      withContext(Dispatchers.IO) {
        try {
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
