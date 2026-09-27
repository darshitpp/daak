# Daak mobile E2E device checklist (Phase 5)

**Nothing in this file has been executed.** It is a manual checklist to be run
by a human on two physical devices on the same Wi-Fi, both with Developer Mode
on. Every box is unchecked, and every box says why it is blocked. No device,
simulator, native build, or pairing run was performed in this environment.

Preconditions: two physical iOS/Android devices, both on the same LAN, both
with camera permission granted to Daak, both running a build produced by
`pnpm --filter @daak/mobile codegen && pod install && xcodebuild` (iOS) or
`./gradlew :app:assembleDebug` (Android). Those builds were never run here —
see `apps/mobile/README.md` for the exact commands and the toolchain gaps.

## Matrix

- [ ] 1. **Pair (QR).** Phone A: Pair → Show QR. Phone B: Pair → Scan. Both show the same 6-digit SAS; confirm on both. Expect `pairing.done` and the peer in Devices on both.
  - BLOCKED: structurally unreachable, not merely untested. The FFI surface binds only `pairing_bundle`, `pair_with` and `accept_pairing` (`crates/daak-ffi/src/daak.udl:71,73`); nothing calls `Engine::offer_pairing` (`crates/daak-core/src/engine.rs:548`), which is what arms the host by setting `pending_pairing`. An inbound pairing therefore reaches `handle_inbound`, finds `pending_pairing` empty, and returns `unpaired inbound connection` (`crates/daak-core/src/engine.rs:812`). The host's `pairing.sas` event can never fire, so the host UI waits forever. The JOINER half is expected to work; only the HOST half is unreachable. Not worked around — the fix is a UDL/wire/FFI change owned by a later phase.
- [ ] 2. **Share in from another app.** In Photos, share an image to Daak. The share target stages it and the app opens the composer prefilled. Select the paired device, Send. The other phone receives a notification with [Open] [Share] [Show in folder].
  - BLOCKED: no devices, no Android build/APK, no iOS build, so the share sheet, the `ShareTargetActivity` intent filter, and the `DaakShareExtension` were never exercised. The Kotlin/Swift is source-level only.
- [ ] 3. **Notification actions.** Tap Share → the OS share sheet opens with the received file. Tap Show in folder → file viewer/documents directory. Tap Open → app opens the inbox entry.
  - BLOCKED: no devices and no native build; no notification action was ever presented or tapped. Also depends on item 1, which cannot complete.
- [ ] 4. **Text → clipboard.** Send a text payload. On receive, a notification appears; open the app and paste into any field — the exact text is on the clipboard.
  - BLOCKED: no devices, no native build, and no real end-to-end send. Depends on item 1.
- [ ] 5. **Direct Share (Android).** Long-press the Daak icon / use the share sheet: a "Send to <Device>" direct-share target appears per paired device. Send an image via it; it goes straight to the paired phone.
  - BLOCKED: no Android device and no Gradle build. Direct-share staging is unit-tested in JS only; the manifest `<queries>`/direct-share entries were never merged or resolved by a real package manager.
- [ ] 6. **Siri / App Intents (iOS).** "Hey Siri, send to a Daak device" → pick device, provide text → app stages and sends.
  - BLOCKED: no iOS device, no Xcode, no `pod install`, so the App Intents extension was never compiled, indexed by Siri, or invoked. Deployment target is pinned to iOS 16.0 for this feature; unverified on any real OS version.
- [ ] 7. **Background drain.** Queue a payload while the peer is offline. Background the sender, bring the peer online. Within the granted BG/WorkManager window the outbox drains; the receiver gets the payload without duplication.
  - BLOCKED: no devices, so no OS ever granted a `BGTaskScheduler` grant or ran a WorkManager job. The drain path is covered only by source-level tests. The Kotlin `earliestSeconds: Double` ↔ TS `number` mapping is a compile-time-only risk that cannot be checked without an Android SDK.
- [ ] 8. **Identity persistence.** Force-quit and relaunch the app (do not uninstall). The fingerprint is unchanged (identity loaded from Keychain/Keystore, not regenerated).
  - BLOCKED: no devices and no native build; the Keychain/Keystore adapters were never executed on a real OS keystore.

## Recording a result

When a human actually runs an item on real hardware, check the box and replace
the BLOCKED line with the date, the two device models/OS versions, and the
observed result. Do not check a box based on unit tests or on the source-grep
pins in `apps/mobile/src/__tests__` — those prove text, not behaviour.
