import AppIntents

/// Siri / Shortcut entry point for "send text to a paired device". It STAGES
/// an intent-send item and returns; the app drains that subdir and hands the
/// text to the engine outbox. Never a blocking transport send.
struct SendToDeviceIntent: AppIntent {
  static var title: LocalizedStringResource = "Send to Device"
  static var description = IntentDescription("Send text to a paired Daak device on this network.")
  static var openAppWhenRun: Bool = true

  @Parameter(title: "Device")
  var device: DaakDeviceEntity

  @Parameter(title: "Text")
  var text: String?

  static var parameterSummary: some ParameterSummary {
    Summary("Send text to the selected Device")
  }

  func perform() async throws -> some IntentResult {
    DaakIntentBridge.shared.stageIntentSend(deviceId: device.id, text: text)
    return .result()
  }
}

struct DaakDeviceEntity: AppEntity {
  static var typeDisplayRepresentation: TypeDisplayRepresentation = "Daak Device"
  static var defaultQuery = DaakDeviceQuery()

  var id: String
  var name: String

  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct DaakDeviceQuery: EntityQuery {
  func entities(for identifiers: [String]) async throws -> [DaakDeviceEntity] {
    DaakIntentBridge.shared.devices()
      .filter { identifiers.contains($0.id) }
      .map { DaakDeviceEntity(id: $0.id, name: $0.name) }
  }

  func suggestedEntities() async throws -> [DaakDeviceEntity] {
    DaakIntentBridge.shared.devices().map { DaakDeviceEntity(id: $0.id, name: $0.name) }
  }
}
