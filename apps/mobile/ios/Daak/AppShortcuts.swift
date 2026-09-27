import AppIntents

struct DaakShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: SendToDeviceIntent(),
      phrases: ["Send to a \(.applicationName) device"],
      shortTitle: "Send",
      systemImageName: "paperplane")
  }
}
