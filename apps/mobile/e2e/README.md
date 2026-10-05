# Daak mobile E2E device checklist (Phase 5)

This is a manual checklist for a human to run on **two physical devices on the
same Wi-Fi**, both with Developer Mode on. The physical-device matrix at the
bottom is **entirely unchecked** — no physical phone has been driven in this
environment.

What *has* been run and proven here, and what has not, is now recorded
separately so the two are never confused:

- **Built / launched in this environment** (see §Verified here below): the
  iOS app builds, installs, launches on the iPhone 17 simulator, and Metro
  renders the real JS UI. The Android app builds, installs, launches on the
  `daak-api36` emulator, and completes onboarding against the real engine. The
  macOS app builds, launches, and stays alive as a menu-bar popover.
- **Driven by hand on macOS**: a person drove the macOS popover and confirmed
  that all five destinations render. Screen capture from the agent returns
  dark pixels on this host, so the agent cannot supply the macOS screenshots.
  A person must confirm the last two macOS checks.
- **Requires two physical devices** (see §Matrix): every item that genuinely
  needs a peer on the LAN. A single machine cannot manufacture LAN traffic, so
  none of these can be checked off from here regardless of build status.

Preconditions for the matrix: two physical devices on the same LAN, camera
permission granted to Daak on both, and builds produced by the commands in
`apps/mobile/README.md`. Item 1 is not structurally blocked any more (see its
note), but it still needs two real devices.

## Verified here (not the matrix)

- **iOS simulator, real JS UI.** `xcodebuild -workspace Daak.xcworkspace -scheme
  Daak ... -sdk iphonesimulator build` succeeds (Xcode 26.3), the app installs
  and launches on the `iPhone 17` simulator, and Metro bundles `index.js` and
  logs Fabric startup. Screenshot pixel sampling returns the exact Open Design
  tokens (`#f7f4ed` background, `#1c1c1c` foreground, `#5f5f5d` muted,
  `#eceae4` border), so this is the real rendered UI, not a bare native shell.
- **macOS desktop app.** `xcodebuild -workspace Daak.xcworkspace -scheme
  Daak-macOS ... build` returns `BUILD SUCCEEDED` and the unsigned app launches
  and stays alive. It is `LSUIElement`, so no ordinary window is expected —
  it is a menu-bar popover. Clicking the status item to confirm the React UI
  renders and `TextInput` does not crash still needs a GUI session (see
  §Blocked here).
- **Android emulator, real JS UI.** `JAVA_HOME=17.0.6-tem`,
  `ANDROID_HOME=/opt/homebrew/share/android-commandlinetools`,
  `./gradlew :app:assembleDebug --offline` returns `BUILD SUCCESSFUL in 54s`
  with `231 actionable tasks: 20 executed, 211 up-to-date`.
  The APK installs on the `daak-api36` AVD and launches after
  `adb reverse tcp:8081 tcp:8081`. The app process stays alive with no
  `UnsatisfiedLinkError` and no `jnidispatch` failure. The runtime UI text
  (`Get started`, `Send photos, files, and text`, `Both devices sit on the
  same Wi-Fi.`) comes from the real React Native tree. Screenshot:
  `/tmp/dk_android_ok.png`.
- **Android onboarding, driven by hand.** All five onboarding steps run on the
  emulator against the real engine. A name typed in step two survives a
  force-stop and a cold restart. The Settings screen reads
  `Seawood Marten · Cedar Lamp`, and the database holds
  `display_name|Cedar Lamp`. The Pair First Device screen renders, and
  `Skip for now` reaches the Send screen.

## Blocked here (environment, not code)

- **Android build needs a manual step on a clean tree.** The first build failed
  at link time with duplicate C++ symbols, because stale ignored output under
  `apps/mobile/android/app/build/generated/source/codegen/jni/` held copies of
  every local TurboModule spec that the app CMake file also globs, while React
  Native linked each module through autolinking. Removing that directory made
  the build pass. No source fix landed, so the step is still required.
- **Interactive macOS popover click.** The GUI session is not reachable from
  the agent environment for screen capture (every capture returns dark pixels),
  so a person must supply the last two macOS screenshots. The popover itself
  does render; a person clicked it and reported all five destinations working.
  `TextInput` on macOS is separately pinned by
  `apps/desktop/test/macos-textinput-typing-attributes.spec.ts`, which compiles
  the real category against React-Core headers.

## Matrix — all items need two physical devices; all unchecked

- [ ] 1. **Pair (QR).** Phone A: Pair → Show QR. Phone B: Pair → Scan. Both
  show the same 6-digit SAS; confirm on both. The peer appears in Devices on
  both.
  - Needs two devices. The two structural blockers this item used to carry
    are **fixed**: the host arm is now `offerPairing` / `armHostPairing` on the
    FFI surface (`offer_pairing` at `crates/daak-ffi/src/daak.udl:102`,
    `arm_host_pairing` at `crates/daak-ffi/src/daak.udl:114`), and
    `pairing.done` exists on `EngineEvent` (`crates/daak-core/src/engine.rs:167`),
    `FfiEvent` (`crates/daak-ffi/src/lib.rs:131`), and the daemon IPC
    (`crates/daak-ipc/src/lib.rs:214`), and `DaemonClient` routes it to the TS
    union (`packages/core/src/engine/DaemonClient.ts:330`). Note that
    the engine auto-commits `upsert_pairing` on both sides and there is no
    separate confirm API, so the SAS comparison is what binds the peer to a
    human; do not treat a Confirm button as the pass criterion.
- [ ] 2. **Share in from another app.** In Photos, share an image to Daak. The
  share target stages it. Select the paired device, Send. The other phone
  receives a notification with [Open] and [Share].
  - Needs two devices and an Android build for the full round trip. The
    composer and the inbound drain are now wired (`drainInbound` → the Send
    draft in `apps/mobile/src/App.tsx`), so a staged share DOES drain and route
    to a prefilled composer. The installed notification buttons remain [Open]
    and [Share] only (`DAK_REGISTERED_ACTIONS`, `packages/platform/src/notify.ts:19`);
    there is no [Show in folder] button on either platform.
- [ ] 3. **Notification actions.** Tap [Share] → the OS share sheet opens with
  the received file. Tap [Open] → app opens the inbox entry.
  - Needs two devices. The handlers are now wired in production
    (`wireNotificationActions` is called by `App.tsx`): [Share] presents the
    real OS share sheet via `mobileInboxActions`, and [Open] routes to the Inbox
    tab. "Show in folder" is **not** a pass criterion: `daak.folder` is still
    withheld from the installed set because reveal has no iOS implementation
    (iOS resolves false by design; Android uses a FileProvider `ACTION_VIEW`).
    See `apps/mobile/src/bootstrap.ts` (`wireNotificationActions`) and
    `apps/mobile/src/App.tsx`.
- [ ] 4. **Text → clipboard.** Send a text payload. On receive, a notification
  appears; open the app and paste into any field — the exact text is on the
  clipboard.
  - Needs two devices. The clipboard routing exists in JS
    (`routeInboxEntry` on the single subscription) and is source-level only here;
    it needs a real send to exercise. Depends on item 1.
- [ ] 5. **Direct Share (Android).** Long-press the Daak icon / use the share
  sheet: a "Send to <Device>" direct-share target appears per paired device.
  Send a **text** payload via it; it goes straight to the paired phone.
  - The Android SDK, NDK, and Gradle are present here, and the debug APK builds
    and launches on the emulator. The check still needs a **paired device** on
    the LAN, so it stays unchecked. Direct-share staging is unit-tested in JS
    only. The shortcut is **TEXT ONLY by design** (`type = "text/plain"`, pinned in
    `DirectShareShortcuts.kt`): the frozen `intent-send` arm carries no file, so
    an image is not a valid check here.
- [ ] 6. **Siri / App Intents (iOS).** "Hey Siri, send to a Daak device" → pick
  device, provide text → app stages and sends.
  - Needs an iOS device with Siri. The App Intents extension was never
    compiled or indexed by Siri here. Deployment target is pinned to iOS 16.0
    for this feature; unverified on any real OS version.
- [ ] 7. **Background drain.** Queue a payload while the peer is offline.
  Background the sender, bring the peer online. Within the granted BG/WorkManager
  window the outbox drains; the receiver gets the payload without duplication.
  - Needs two devices, so no OS ever granted a `BGTaskScheduler` grant or ran a
    WorkManager job here. The drain path is covered only by source-level tests.
    The Kotlin `earliestSeconds: Double` ↔ TS `number` mapping is a
    compile-time-only risk that cannot be checked without an Android SDK.
- [ ] 8. **Identity persistence.** Force-quit and relaunch the app (do not
  uninstall). The fingerprint is unchanged (identity loaded from
  Keychain/Keystore, not regenerated).
  - Needs a device. The Keychain/Keystore adapters were not executed on a real
    OS keystore here. (The macOS keychain path IS exercised at runtime — it
    refuses to start on a certificate-less host by design, which is a real
    keystore interaction, but that is not the iOS/Android item.)

## Recording a result

When a human actually runs a matrix item on real hardware, check the box and
replace the note with the date, the two device models/OS versions, and the
observed result. Do not check a box based on unit tests or on the source-grep
pins in `apps/mobile/src/__tests__` — those prove text, not behaviour. None of
the matrix items can be checked from a single machine or a simulator; they need
a real peer on the LAN.
