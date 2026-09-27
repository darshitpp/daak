# Daak mobile E2E device checklist (Phase 5)

**Nothing in this file has been executed.** It is a manual checklist to be run
by a human on two physical devices on the same Wi-Fi, both with Developer Mode
on. Every box is unchecked and every box says why it is blocked. No native
build, no simulator, no device run, and no pairing run was performed in this
environment.

Preconditions: two physical devices on the same LAN, camera permission granted
to Daak, and builds produced by the commands in `apps/mobile/README.md` — which
have never been run here. Note that item 1 is structurally blocked on both
sides, so a full pass of this matrix is not currently possible.

## Matrix

- [ ] 1. **Pair (QR).** Phone A: Pair → Show QR. Phone B: Pair → Scan. Both show the same 6-digit SAS; confirm on both. The peer should appear in Devices on both.
  - BLOCKED (two independent structural blockers; the joiner half is the only part expected to work):
    1. **The host half is unreachable.** The FFI surface binds only `pairing_bundle`, `pair_with` and `accept_pairing` (`crates/daak-ffi/src/daak.udl:71-73`); nothing calls `Engine::offer_pairing` (`crates/daak-core/src/engine.rs:568`), which is what arms the host by setting `pending_pairing`. An inbound pairing therefore reaches `handle_inbound`, finds `pending_pairing` empty, and returns `unpaired inbound connection` (`crates/daak-core/src/engine.rs:836`). The host's `pairing.sas` event can never fire, so the host UI waits forever.
    2. **`pairing.done` does not exist.** `EngineEvent` (`crates/daak-core/src/engine.rs:50-95`) has no `PairingDone` variant, `FfiEvent` (`crates/daak-ffi/src/lib.rs:99-108`) has none, and `DaemonClient` drops the name as an unknown variant (`packages/core/src/engine/DaemonClient.ts:261-264`). A dead `pairing.done` member nonetheless survives in the TS union (`packages/core/src/engine/types.ts:32`) with a handler at `apps/mobile/src/bootstrap.ts:106`; neither is reachable. Recorded only — not changed here.
    Also: "confirm on both" is not a real pass criterion. The engine auto-commits `upsert_pairing` on both sides and there is no confirm API on the frozen surface, so the SAS Confirm button gates nothing.
- [ ] 2. **Share in from another app.** In Photos, share an image to Daak. The share target stages it. Select the paired device, Send. The other phone receives a notification with [Open] and [Share]. (The plan's "app opens the composer prefilled" step is unachievable today — see below.)
  - BLOCKED: no devices, no Android build/APK, no iOS build, so the share sheet, the `ShareTargetActivity` intent filter and the `DaakShareExtension` were never exercised — the Kotlin/Swift is source-level only. Two more gaps, both structural: **the installed notification buttons are [Open] and [Share] only** — `DAK_REGISTERED_ACTIONS = ['daak.open', 'daak.share']` (`packages/platform/src/notify.ts:19`); there is no [Show in folder]. And **the composer does not exist in the app**: `ComposerScreen` (`packages/ui/src/screens/ComposerScreen.tsx`) has zero render sites under `apps/mobile/`, and `drainInbound` is deliberately unwired (ledger R22), so a staged share is not drained, not routed, and no prefilled composer opens.
- [ ] 3. **Notification actions.** Tap [Share] → the OS share sheet opens with the received file. Tap [Open] → app opens the inbox entry.
  - BLOCKED: no devices and no native build, so no notification action was ever presented or tapped. "Show in folder" is **not** a pass criterion: `daak.folder` is in the frozen `DAK_RECEIVED_ACTIONS` vocabulary but deliberately withheld from the installed set because reveal has no implementation on either platform (iOS needs a QuickLook preview, Android a FileProvider `ACTION_VIEW`; see `apps/mobile/src/bootstrap.ts:228-235`). The button is not shown, so the missing reveal is unreachable. Separately, `wireNotificationActions` (`apps/mobile/src/bootstrap.ts:235`) has **no production call site** — only tests call it — so even [Open] and [Share] have no handler wired in the app. Depends on item 1, which cannot complete.
- [ ] 4. **Text → clipboard.** Send a text payload. On receive, a notification appears; open the app and paste into any field — the exact text is on the clipboard.
  - BLOCKED: no devices, no native build, and no real end-to-end send. The clipboard routing exists in JS (`routeInboxEntry` on the single subscription, `apps/mobile/src/bootstrap.ts:112`) and is source-level only. Depends on item 1.
- [ ] 5. **Direct Share (Android).** Long-press the Daak icon / use the share sheet: a "Send to <Device>" direct-share target appears per paired device. Send a **text** payload via it; it goes straight to the paired phone.
  - BLOCKED: no Android device and no Gradle build. Direct-share staging is unit-tested in JS only; the manifest `<queries>`/direct-share entries were never merged or resolved by a real package manager. Note the shortcut is **TEXT ONLY by design**: `type = "text/plain"` is pinned at `apps/mobile/android/app/src/main/java/dev/darshit/daak/shortcuts/DirectShareShortcuts.kt:66` (R30) because the frozen `intent-send` arm carries no file. Sending an image through it advertises a target that goes nowhere, so an image is not a valid check here.
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
pins in `apps/mobile/src/__tests__` — those prove text, not behaviour. Note that
item 1 cannot be checked at all until the two structural blockers above are
fixed in a later phase; checking it would be a false claim.
