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
}

/// The on-disk stash for a tapped action, in the App Group so it survives the
/// process being killed between the tap and JS booting. In-memory cannot: iOS
/// launches us precisely when the memory is gone. This is the write-then-rename
/// shape every other stager in this repo uses (DaakIntentBridge.stageIntentSend)
/// -- a process killed mid-write leaves a `.tmp` the reader ignores, never a
/// truncated file that looks real. Last write wins, deliberately.
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
    let tmp = final.appendingPathComponent(final.lastPathComponent + ".tmp")
    do {
      try data.write(to: tmp, options: .atomic)
      // replaceItemAt when one is already there, so a second tap overwrites
      // rather than failing on an existing file.
      if fm.fileExists(atPath: final.path) {
        _ = try fm.replaceItemAt(final, withItemAt: tmp)
      } else {
        try fm.moveItem(at: tmp, to: final)
      }
    } catch {
      try? fm.removeItem(at: tmp)
    }
  }

  /// Reads WITHOUT deleting. The module holds the value in memory and deletes
  /// the file only once JS has taken it, so a second process death before the
  /// drain still finds the action on disk.
  /// - Returns: JSON `{action, payload}`, or "" when nothing is stashed.
  static func peek() -> String {
    let fm = FileManager.default
    guard let container = fm.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    else { return "" }
    let final = container.appendingPathComponent(relativePath)
    guard let data = try? Data(contentsOf: final),
          let json = String(data: data, encoding: .utf8), !json.isEmpty
    else { return "" }
    return json
  }

  /// Deletes the stash. Called by the module once consumePendingAction has
  /// handed the value to JS.
  static func clear() {
    let fm = FileManager.default
    guard let container = fm.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    else { return }
    try? fm.removeItem(at: container.appendingPathComponent(relativePath))
  }
}
