package dev.darshit.daak.bgsched

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import java.util.concurrent.TimeUnit

/**
 * The Android half of background execution.
 *
 * Nothing here sends. Every method either books an OS slot, holds the process
 * up while the outbox delivers, records that state for the worker, or opens a
 * system settings screen the user asked for. The engine's outbox owns delivery.
 *
 * addListener/removeListeners are no-ops because there are no events: the Spec
 * declares them because the codegen protocol requires the pair, and the iOS
 * half is an RCTEventEmitter for the same reason. The plan's DaakBgEvent
 * channel existed only to feed an engine wake method, which does not exist
 * until Phase 7 (GAP 2 / R4) -- an emitter with no consumer is a second thing
 * to keep in sync for no user-visible gain.
 */
@ReactModule(name = DaakBgSchedModule.NAME)
class DaakBgSchedModule(private val ctx: ReactApplicationContext) :
    NativeDaakBgSchedSpec(ctx) {
  companion object {
    const val NAME = "DaakBgSched"
    private const val PERIODIC = "daak-drain-periodic"
    private const val ONE_SHOT = "daak-drain-now"
  }

  init {
    // The worker cannot construct a React context, and a worker that reached
    // into the engine would be the coupling GAP 1 exists to avoid. A shared
    // preference flag written by start/stopForegroundSync is the whole contract.
    DaakDrainWorker.installProbe {
      ctx.getSharedPreferences("daak.bgsched", Context.MODE_PRIVATE)
          .getBoolean("transfer-active", false)
    }
  }

  override fun getName() = NAME

  override fun configure(promise: Promise) {
    try {
      // KEEP, not UPDATE: an existing schedule already has a next window, and
      // REPLACE/resetting it on every app start is how a user ends up with a
      // job that never runs.
      WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
          PERIODIC,
          ExistingPeriodicWorkPolicy.KEEP,
          PeriodicWorkRequestBuilder<DaakDrainWorker>(15, TimeUnit.MINUTES).build())
      promise.resolve(null)
    } catch (t: Throwable) {
      // A WorkManager that cannot initialise must not reject initBackgroundSync
      // into app startup; the caller already treats this as best-effort.
      promise.resolve(null)
    }
  }

  // iOS-only concepts. Resolving is the honest answer: there is nothing to do,
  // and a rejection would report a failure on a platform that has no failure.
  override fun scheduleAppRefresh(promise: Promise) = promise.resolve(null)

  override fun scheduleProcessing(earliestSeconds: Double, promise: Promise) =
      promise.resolve(null)

  override fun startForegroundSync(label: String, promise: Promise) {
    DaakDrainWorker.setTransferActive(ctx, true)
    DaakSyncService.start(ctx, label)
    promise.resolve(null)
  }

  override fun stopForegroundSync(promise: Promise) {
    DaakDrainWorker.setTransferActive(ctx, false)
    ctx.stopService(Intent(ctx, DaakSyncService::class.java))
    promise.resolve(null)
  }

  /**
   * A WAKE, not a drain. The periodic job already covers the recurring case;
   * this is the one-shot REPLACE so a caller that wants a poke right now gets
   * one without resetting the periodic schedule.
   */
  override fun enqueueDrain(promise: Promise) {
    try {
      WorkManager.getInstance(ctx).enqueueUniqueWork(
          ONE_SHOT, ExistingWorkPolicy.REPLACE, OneTimeWorkRequestBuilder<DaakDrainWorker>().build())
    } catch (t: Throwable) {
      // Best effort, same reasoning as configure.
    }
    promise.resolve(null)
  }

  /**
   * Opens the OS battery-optimisation allowlist. USER-INITIATED: this navigates
   * away from the app, so the Settings screen is the only permitted caller and
   * the pin that holds that lives in apps/mobile.
   *
   * Already-exempt is answered without opening anything: re-sending the user to
   * a screen showing the setting they already granted is a worse answer than
   * silence.
   */
  override fun requestBatteryExemption(promise: Promise) {
    val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
    if (!pm.isIgnoringBatteryOptimizations(ctx.packageName)) {
      try {
        ctx.startActivity(
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                .setData(Uri.parse("package:" + ctx.packageName))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      } catch (t: Throwable) {
        // Some OEM builds ship no such screen. Not an error the user can act
        // on, so resolve rather than reject.
      }
    }
    promise.resolve(null)
  }

  override fun addListener(eventName: String) = Unit

  override fun removeListeners(count: Double) = Unit
}
