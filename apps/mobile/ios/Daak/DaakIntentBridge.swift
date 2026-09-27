import Foundation

/// Reads the App Group state App Intents need, and stages an intent-send item.
/// Staging only: nothing here sends, the engine outbox owns delivery.
/// `pairedDevices` is written by DaakShare.updateShortcutTargets, the one
/// native method the TurboModule exposes for it (R26).
@objc final class DaakIntentBridge: NSObject {
  @objc static let shared = DaakIntentBridge()

  private let appGroup = "group.dev.darshit.daak"

  func devices() -> [(id: String, name: String)] {
    guard let data = UserDefaults(suiteName: appGroup)?.data(forKey: "pairedDevices"),
          let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: String]] else { return [] }
    return arr.compactMap { d in
      guard let id = d["deviceId"], let name = d["name"] else { return nil }
      return (id, name)
    }
  }

  func stageIntentSend(deviceId: String, text: String?) {
    let fm = FileManager.default
    guard let container = fm.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return }
    // Its OWN subdir, a sibling of batches/. The drain for this is
    // DaakShare.consumeIntentSends, which cannot see a text/file batch, so a
    // Siri send never deletes metadata naming a staged share (R25).
    let dir = container.appendingPathComponent("share-inbox/intent-sends", isDirectory: true)
    try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
    var item: [String: String] = ["kind": "intent-send", "deviceId": deviceId]
    if let text, !text.isEmpty { item["text"] = text }
    guard let data = try? JSONSerialization.data(withJSONObject: [item]) else { return }
    // Write-then-rename, same as every other stager: a process killed mid-write
    // leaves a .tmp the drain ignores, never a truncated .json that looks real.
    let final = dir.appendingPathComponent(UUID().uuidString + ".json")
    let tmp = dir.appendingPathComponent(final.lastPathComponent + ".tmp")
    do {
      try data.write(to: tmp, options: .atomic)
      try fm.moveItem(at: tmp, to: final)
    } catch {
      try? fm.removeItem(at: tmp)
      return
    }
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(),
      CFNotificationName("dev.darshit.daak.share.inbox.changed" as CFString), nil, nil, true)
  }
}
