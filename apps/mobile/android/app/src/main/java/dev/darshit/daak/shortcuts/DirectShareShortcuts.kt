package dev.darshit.daak.shortcuts

import android.content.Context
import android.content.Intent
import android.content.pm.Person
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.os.Build
import dev.darshit.daak.R
import dev.darshit.daak.share.ShareTargetActivity

/**
 * Per-device Direct Share: one long-lived dynamic shortcut per paired peer,
 * each firing ShareTargetActivity with `daak.target_device` already set. The
 * activity still only STAGES; the engine outbox owns the send, so tapping a
 * shortcut never blocks on a peer.
 *
 * This lives in the app module because it owns the drawable and the activity.
 * DaakShareModule reaches it reflectively, so the library half of the
 * TurboModule does not need a compile-time dependency on the app.
 */
object DirectShareShortcuts {
  private const val CATEGORY_CONVERSATION = "android.shortcut.conversation"

  /** @param devices `(deviceId, name)` pairs, the shape [sync] is invoked with. */
  @JvmStatic
  @Suppress("DEPRECATION")
  fun sync(context: Context, devices: List<Pair<String, String>>) {
    // minSdkVersion is 24 (deliberately, per the plan) and updateShortcutTargets
    // is wired into startEngine on EVERY launch, so a single unguarded touch of
    // an API-30 symbol is a NoSuchMethodError on five of the seven supported
    // levels -- a crash, not a degraded feature. Raising minSdk to buy a
    // shortcut is the wrong trade, so degrade instead.
    //
    // Below API 30 this is a clean no-op. Dynamic shortcuts do exist from 25,
    // and even the conversation category from 30 only via this class overload,
    // but the share sheet still works and the engine outbox still sends --
    // Direct Share is an accelerator, not the only route.
    // ponytail: no shortcuts at all on API 24-29. Upgrade if that matters:
    // ShortcutManager via getSystemService(ShortcutManager::class.java)
    // (25+, guarded on S) with longLived=true and no Person/category, which is
    // what the people-and-conversations surface is actually for.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      return
    }
    val manager = context.getSystemService(ShortcutManager::class.java) ?: return
    val shortcuts = devices.take(manager.maxShortcutCountPerActivity).map { (id, name) ->
      val person = Person.Builder().setName(name).setKey(id).build()
      ShortcutInfo.Builder(context, "daak.send.$id")
        .setShortLabel(name)
        .setLongLabel("Send to $name")
        .setIcon(Icon.createWithResource(context, R.drawable.ic_daak_device))
        .setPerson(person)
        .setLongLived(true)
        .setCategories(setOf(CATEGORY_CONVERSATION))
        .setIntent(
          Intent(context, ShareTargetActivity::class.java).apply {
            action = Intent.ACTION_SEND
            // R30: TEXT ONLY. The frozen R7 InboundShareItem union has no
            // file arm for a send, and ShareTargetActivity stages a stream
            // into batches/ (undeleted, awaiting the composer route Task 11
            // owns) while putting only EXTRA_TEXT into intent-sends. A
            // "*/*" shortcut therefore advertises an image that goes
            // nowhere. Do not widen this until intent-send can carry a file.
            type = "text/plain"
            putExtra("daak.target_device", id)
          })
        .build()
    }
    // setDynamicShortcuts REPLACES the whole set, so an unpaired peer
    // disappears here. That is the only writer of the shortcut list.
    manager.setDynamicShortcuts(shortcuts)
  }
}
