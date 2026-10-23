# @daak/mobile

The React Native app shell (iOS + Android) driving the in-process
`DaakEngine` TurboModule from `packages/core`.

## Canonical commands

Run from the repo root. `cargo` needs `export PATH="$HOME/.cargo/bin:$PATH"`.

### Runs and verified here

```bash
pnpm typecheck                        # turbo typecheck, 9/9 packages
pnpm test                             # turbo test, 9/9 packages
pnpm --filter @daak/core test         # needs socket bind; see the sandbox note
pnpm --filter @daak/mobile test       # jest, 25 suites / 282 tests
pnpm --filter @daak/ui test           # jest, 16 suites / 89 tests
pnpm --filter @daak/platform test     # vitest, 10 files / 75 tests
pnpm --filter @daak/desktop test      # vitest, 14 files / 132 tests
```

`@daak/core`'s vitest run includes a `daakd` socket contract suite that spawns
the daemon and binds a Unix socket. In a restricted sandbox that fails ~13
tests with `Operation not permitted`; unsandboxed it passes 87/87. That is an
environment limit, not a code failure — run it escalated on a real host.

The CI gate is `pnpm turbo typecheck test` (`.github/workflows/ci.yml`, after
`cargo build -p daakd`, which is prebuilt in CI). It is not in the verified list
above only because the sandbox denies the core daemon socket suite.

### Native builds

```bash
# iOS — VERIFIED: builds, installs, launches on the iPhone 17 simulator
cd apps/mobile/ios && pod install    # generates Daak.xcworkspace (already present)
xcodebuild -workspace Daak.xcworkspace -scheme Daak -configuration Debug \
  -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17' build

# Codegen for the TurboModule specs (run after a spec change, before a build)
pnpm --filter @daak/mobile codegen
```

Verified iOS facts on this host: full Xcode is present (`xcode-select -p` =
`/Applications/Xcode.app/Contents/Developer`, Xcode 26.3), `pod` is on PATH,
`Daak.xcworkspace` exists, and `pod install` has run. The Debug build succeeds,
the app installs and launches on the `iPhone 17` simulator, and Metro (port
8081) bundles `index.js` and logs React Native Fabric startup. Screenshot pixel
sampling returns the exact Open Design tokens, confirming the real JS UI
renders rather than a bare native shell.

### Android — VERIFIED: builds, installs, launches on the emulator

```bash
export JAVA_HOME=<path to a JDK 17>
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export ANDROID_SDK_ROOT="$ANDROID_HOME"
cd apps/mobile/android && ./gradlew :app:assembleDebug --offline
```

Real output on 2026-10-05:

```text
BUILD SUCCESSFUL in 54s
231 actionable tasks: 20 executed, 211 up-to-date
```

```bash
adb reverse tcp:8081 tcp:8081     # Metro on 8081; without it the app shows the Metro error
adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n dev.darshit.daak/.MainActivity
```

The AVD is `daak-api36` (system image android-36). The app process stayed
alive. No `UnsatisfiedLinkError` and no `jnidispatch` failure appeared. The
runtime UI text came from the real React Native tree:

```text
Get started / I already paired this phone
Send photos, files, and text
Both devices sit on the same Wi-Fi.
No account, no sign-up, no cloud.
Three things to know
Works with the internet off
Airplane mode is fine. Only your own Wi-Fi is ever used.
```

The Welcome words changed on 2026-10-09 (plan P4). This block records the build of 2026-10-05.

Screenshot: `/tmp/dk_android_ok.png`. The APK is 141,406,494 bytes.

The APK is a kept artifact. The user installs it.

### Android onboarding, driven by hand on 2026-10-05

The full onboarding flow runs on the emulator. The run used the real engine.
It typed the name `Cedar Lamp`, granted the notification permission, and chose
`Skip for now` on the Pair First Device screen.

```bash
adb shell pm clear dev.darshit.daak          # start from a clean state
adb shell input tap 540 1837                 # Skip for now on the Pair screen
adb shell 'run-as dev.darshit.daak sqlite3 files/daak/daak.db \
  "select key,cast(value as text) from settings;"'
```

Real output of the SQLite query after the app was force-stopped and started
again:

```text
display_name|Cedar Lamp
```

The Settings screen after that restart read:

```text
Seawood Marten · Cedar Lamp
```

The resolved name carries a collision suffix. The stored base name does not.
The Settings text field showed `Cedar Lamp` after the restart. This proves the
R42 fix works on a real Android run.

Screenshots of the five onboarding steps are in `/tmp/dk_final/onb/`. The five
destination screens are in `/tmp/dk_final/android/`.

### Known Android defect, NOT permanently fixed

The first `:app:assembleDebug` failed at link time with duplicate C++ symbols.
The cause was stale ignored output under
`apps/mobile/android/app/build/generated/source/codegen/jni/`, which held
copies of every local TurboModule spec at once. The app CMake file globs every
`.cpp` there, and React Native also links each local module through
autolinking, so each module was compiled twice under two object names.

Removing that directory made the build pass. No source fix landed. The proof
required a manual removal, so a clean checkout can reproduce the failure. After
the passing build the directory holds only `DaakSpec-generated.cpp` and
`react/`, which is what the codegen step alone produces, and `apps/mobile/.gitignore`
ignores it.

```bash
rm -rf apps/mobile/android/app/build/generated/source/codegen/jni
```

### Recorded, NOT run in this environment

```bash
# Android share-target smoke — needs a device or emulator with Daak installed
adb shell am start -a android.intent.action.SEND -t text/plain \
  --es android.intent.extra.TEXT "hi" -n dev.darshit.daak/.share.ShareTargetActivity
```

There is no `lint` script anywhere in the workspace: the root `lint` script only
forwards to `turbo run lint` and no package defines a `lint` task, so
`pnpm lint` is a no-op. Do not record it as a gate.

Schemes that exist: `Daak` and `DaakShareExtension`
(`apps/mobile/ios/Daak.xcodeproj/xcshareddata/xcschemes/`). `Daak.xcworkspace`
is generated by `pod install` and is present here.

## Diagnostics

### Get the bundle

Open Settings, then Report an issue. The app opens the share sheet with the
bundle text. The bundle holds the app version, the device id, the address, and
the recent log. It holds no display names.

The log lives in memory only. The app loses it when the app quits or crashes.
The ring keeps the last 2000 lines. Export the bundle before you quit the app.

### Live filters

The engine writes each log line to the OS log and to the ring. The filters
below show the engine lines and the native module lines. JavaScript lines
appear in the OS log only if their text matches the filter. This is expected,
not verified.

On Apple, the engine uses the subsystem `dev.darshit.daak` and the category
`engine`. The native modules use `NSLog` with the prefix `Daak:`.

```bash
# Recorded, NOT run in this environment: needs a simulator or a device with Daak running.
# The zsh shell has a builtin named log. Use /usr/bin/log.
xcrun simctl spawn booted log stream --level debug \
  --predicate 'subsystem CONTAINS "daak" OR eventMessage CONTAINS "Daak"'   # simulator
/usr/bin/log stream --level debug \
  --predicate 'subsystem CONTAINS "daak" OR eventMessage CONTAINS "Daak"'   # macOS app
```

For a physical iPhone, open Console.app, select the device, and paste the same
predicate in the search field. Always bound a `log stream` run. Stop it with
Ctrl-C.

A `log show` query with the engine subsystem ran here and exited zero. The
macOS host had no Daak process, so the output was only the column header. This
proves the predicate is valid. It does not prove that the engine lines appear.

```bash
# VERIFIED: exited 0 on this host (output: the header line only, no Daak process ran)
/usr/bin/log show --last 1m --predicate 'subsystem == "dev.darshit.daak"' --style compact
```

On Android, the engine uses the logcat tag `daak`. The native code uses these
tags: `Daak`, `DaakNotify`, `DaakSecureStore`, `DaakSyncService`,
`DaakDrainWorker`, `DaakFsPaths`, `ShareTarget`, and `KeystoreSecureStore`.

```bash
# Recorded, NOT run in this environment: needs an emulator or a device with Daak running.
# On this host `adb devices` listed no device, and `adb logcat` waits for one.
adb logcat -s daak Daak DaakNotify DaakSecureStore DaakSyncService DaakDrainWorker DaakFsPaths ShareTarget KeystoreSecureStore
# Add ReactNativeJS to show the JavaScript console.warn lines.
# JavaScript visibility under this tag is expected, not verified.
adb logcat -s daak Daak DaakNotify DaakSecureStore DaakSyncService DaakDrainWorker DaakFsPaths ShareTarget KeystoreSecureStore ReactNativeJS
# Print the buffer once and exit:
adb logcat -d -s daak
```

On Android, the layer for the tag `daak` can fail to start. Then the app keeps
the ring only. Use the bundle in that case.

## Profiling

Span durations show only in the exported bundle. The OS log shows the engine
events with time stamps. It does not show how long a span ran.

### Apple: Instruments

Use a device build. A build with a debugger attached can change timing.

```text
# Recorded, NOT run in this environment: needs a physical device and Xcode.
```

1. First, build and install the app on the device. Use the Release
   configuration to measure speed.
2. Then open Instruments (Xcode, Open Developer Tool, Instruments).
3. Choose the Blank template. Add the `os_log` instrument.
4. Select the device and the Daak process as the target.
5. Press Record. Do the action to measure, for example a transfer.
6. Press Stop. In the `os_log` track, filter by subsystem `dev.darshit.daak`.
7. Read the engine events and their time stamps. To see span durations, export
   the bundle from Settings, Report an issue.

### Android: Perfetto and logcat

Use logcat for the engine lines. Use Perfetto for system traces, such as CPU
scheduling and frame timing.

```text
# Recorded, NOT run in this environment: needs an emulator or a device.
```

Rust spans do not show in Perfetto in this version. A Perfetto layer for
`tracing` exists as a separate crate, `tracing_android_trace`. This project
does not use it. For span durations, export the bundle from Settings, Report an issue.

## Prerequisites / not verified in this environment

- **The Android SDK, NDK, and Gradle are present here.** Platform
  android-35, build-tools 35.0.0, NDK 26.1.10909125, command-line tools at
  `/opt/homebrew/share/android-commandlinetools`, already written to
  `apps/mobile/android/local.properties`. Gradle 8.10.2 and AGP 8.6.0 are in
  `~/.gradle`, so the build must run with `--offline`. The Kotlin files in
  `apps/mobile/android` are now compiled, not source-level only.
- **JDK mismatch (R9), still true.** The host's default JDK is 25; AGP 8.6
  rejects it. Export `JAVA_HOME` as the path to a JDK 17
  before `./gradlew`. This is why the verified command above sets it.
- **No physical iOS/Android devices.** The iOS simulator and the Android
  emulator are both proven. A real phone is not. The two-device LAN matrix in
  [`e2e/README.md`](e2e/README.md) is entirely unchecked.

The `daak-ffi` bindings were checked against real `uniffi_bindgen` output, which
proves the surface matches the crate — not that every packaging artifact links
on every ABI. Two known consequences on a real Android host: the generated
Android bindings look for `uniffi_daak_ffi` while the cdylib is `libdaak_ffi.so`,
so `engine.start()` will raise `UnsatisfiedLinkError` until packaging ships the
`.so` per ABI.

The prototype onboarding screens (Welcome, Name Device, Permissions, Pair First
Device, Update Required) are intentionally NOT faked in the app: they have no
authoritative durable "onboarding complete" source or permission-inspection API
behind them, so a UI-only flag would be fake state. The real app covers the
functional prototype screens — Devices, Thread,
Settings, Quarantine (per-item transfer state) — and handles
device naming and presence through Settings against the live engine.
