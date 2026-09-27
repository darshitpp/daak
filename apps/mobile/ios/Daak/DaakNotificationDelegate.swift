import Foundation
import UserNotifications

/// R32/Critical 3: the UNUserNotificationCenter delegate, installed at APP
/// LAUNCH rather than from JS.
///
/// Installing it from `registerCategories` only ever worked while the app was
/// already running. On a KILLED app iOS launches the process and delivers the
/// tapped response at launch, BEFORE the JS bridge exists: the delegate was
/// nil, `didReceive` never ran, and the tap was lost -- which is exactly the
/// case the stash exists for. So the delegate is installed from AppDelegate's
/// `didFinishLaunching`, and it is a `static let shared` so it is retained for
/// the process lifetime (`UNUserNotificationCenter.delegate` is a weak
/// reference, so a plain local would be released at the end of launch).
///
/// This is app-side work the brief did not scope. It is the smallest correct
/// shape, and it is required: no library-side change can make the system call
/// back before the host app has launched.
@objc final class DaakNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
  @objc static let shared = DaakNotificationDelegate()

  private override init() { super.init() }

  /// Installs the delegate. Idempotent; call from
  /// `application:didFinishLaunchingWithOptions:` before anything can be
  /// delivered.
  @objc static func install() {
    UNUserNotificationCenter.current().delegate = shared
  }

  /// R33: NO transport, no crypto, no outbox. `daak.share` opens the OS share
  /// sheet in JS (presentShare); the engine's outbox owns every actual send.
  /// This only records WHICH action was tapped.
  func userNotificationCenter(_ center: UNUserNotificationCenter,
                              didReceive response: UNNotificationResponse,
                              withCompletionHandler completionHandler: @escaping () -> Void) {
    let payload = response.notification.request.content.userInfo["payload"] as? String ?? "{}"
    // Written FIRST and unconditionally: on a cold start this is the only copy
    // of the action that exists, and the reader only deletes it once JS has
    // actually taken it.
    DaakNotifyActionStash.store(action: response.actionIdentifier, payload: payload)
    // The live wakeup. A Darwin notification is the ONLY channel that crosses
    // from the app target to the pod target without an import between them, and
    // this repo already uses exactly this pair (DaakIntentBridge posts,
    // DaakShare observes). The payload rides in the file, not in the wakeup.
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(),
      CFNotificationName(DaakNotifyActionStash.changed as CFString), nil, nil, true)
    completionHandler()
  }

  /// willPresent is deliberately absent: without it a notification that arrives
  /// while the app is open is not shown, and this app's inbox already renders
  /// the transfer. Add a willPresent returning [[.banner]] if the design ever
  /// wants the banner while foregrounded.
}

/// The on-disk stash for a tapped action, in the App Group so it survives the
/// process being killed between the tap and JS booting. In-memory cannot: iOS
/// launches us precisely when the memory is gone. Last write wins, deliberately.
///
/// This half is WRITE-ONLY. The reader is DaakNotifyActionFile in the pod
/// (modules/rn-notify/ios/DaakNotify.swift), taken under one lock, because the
/// file has two consumers on two threads; a second copy of the reader here would
/// be unsynchronised by construction and would drift.
enum DaakNotifyActionStash {
  private static let appGroup = "group.dev.darshit.daak"
  private static let relativePath = "notify/pending-action.json"
  /// Posted by the launch delegate, observed by DaakNotify in the pod. Kept as
  /// a plain string so neither side imports the other.
  static let changed = "dev.darshit.daak.notify.action.changed"

  static func store(action: String, payload: String) {
    let fm = FileManager.default
    guard let container = fm.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    else { return }
    let final = container.appendingPathComponent(relativePath)
    try? fm.createDirectory(at: final.deletingLastPathComponent(),
                            withIntermediateDirectories: true)
    guard let data = try? JSONSerialization.data(
      withJSONObject: ["action": action, "payload": payload]) else { return }
    // .atomic IS write-then-rename onto this exact path, and it overwrites an
    // existing file. The tmp + fileExists + file-swap dance it replaces was
    // strictly worse: the swap can leave the destination empty on a container
    // filesystem, which silently drops the stashed action -- the exact loss
    // this file exists to prevent.
    try? data.write(to: final, options: .atomic)
  }
}
