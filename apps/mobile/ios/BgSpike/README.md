# iOS background-realism spike (spec section 9, open question 1)

Instrumented identifiers, both registered and submitted by
`apps/mobile/ios/Daak/DaakBgLaunch.swift`: `dev.darshit.daak.processing`
(BGProcessingTask) and `dev.darshit.daak.refresh` (BGAppRefreshTask).

## What is actually measured

`handle(_:)` appends one JSON line per delivery to `bg-spike.jsonl` in the App
Group container `group.dev.darshit.daak`:

```json
{"taskId":"dev.darshit.daak.refresh","startedAt":<epoch ms>,"grantedMs":<real>}
```

`grantedMs` is the real window: the instant the handler is entered to the
instant it completes. It is the only field, and the reason is the finding, not
an omission.

**`grantedMs` is 0 on every real record today, and that is also a finding.** The
handler is a no-op beyond completing and rescheduling the task (see
`DaakBgLaunch.swift`), so the measured window truncates to 0 ms and
`backgroundedRatio` reports 0 for any real log. The only number a current run
can honestly report is `attempts`: how many times in 24 h the OS granted a slot
at all. That is the grant-rate half of the criterion; the other half, and the
threshold that consumes `grantedMs`, come into use when the handler has a real
grant body.

## The pass criterion is currently STRUCTURALLY UNREACHABLE

`apps/mobile/scripts/bg-spike.mjs` passes only when at least 60% of attempts
received a non-zero grant AND the median drain delay after reconnect is at most
15 minutes. The second half reads `dueAtStart` and `drained` from each record.

**Nothing can produce those two fields today.** A BGTask is delivered by the OS
into a process whose JS bridge may not exist, and the engine exposes no wake,
no drain and no outbox row count on this side until Phase 7 Task 3 (GAP 1/GAP 2,
R61). The plan's `wakeEngine` stub posted a Notification nobody observed and
returned a hard-coded `0`, which would have made the run below look like it
validated background drain when it measured nothing at all (R127).

So on any real log produced today: `attempts` and `backgroundedRatio` are real,
`medianDrainDelayMs` is always `null`, and `passes` is always `false`. A run
today measures the GRANT RATE only. The other half becomes reachable when the
engine wake exists; nothing in this spike needs changing to consume it.

## Procedure (nothing below has been run)

No device, no full Xcode (CommandLineTools only), no CocoaPods and no
xcworkspace exist on the host this was written on, so every box is unticked and
no UDID, OS version or device name is recorded. Steps 1 through 5 are the plan's
procedure with one correction, noted at step 4.

- [ ] 1. Install the Debug build on a physical iPhone via
      `xcodebuild -workspace Daak.xcworkspace -scheme Daak -configuration Debug -destination 'generic/platform=iOS'`.
      BLOCKED: `xcodebuild` requires a full Xcode install.
- [ ] 2. Pair with a desktop peer, then queue at least 3 files while the peer is
      offline; note the reconnect wall-clock time as `RECONNECT_AT` (epoch ms).
- [ ] 3. Background Daak and leave the phone locked and discharging for 24 h;
      do not open Daak.
- [ ] 4. Export `bg-spike.jsonl` off the device. **Corrected:** `devicectl`
      cannot read another container's App Group directory. It can only copy
      from the app data container, and the file lives in the shared App Group
      container `group.dev.darshit.daak`, so the plan's
      `--domain-identifier dev.darshit.daak --source Documents/bg-spike.jsonl`
      names a path that does not exist, and the `DaakSpikeExport` flag it
      mentions does not exist either. The honest route today is a share
      extension or a debug-only in-app export that copies the file out of the
      App Group into the app container; neither is built, so this step is not
      runnable as specified.
- [ ] 5. Summarize: `RECONNECT_AT=<ms> node apps/mobile/scripts/bg-spike.mjs <exported.jsonl>`.

## Reading a real run

`backgroundedRatio` is the grant rate and is the only number a current run can
report. The plan's fallback when the OS throttles is the shipped behaviour
already, not a future change: the app never claims guaranteed delivery, it
shows the `BackgroundHint` copy ("Keep Daak open to sync now. iOS decides when
background sync runs."), and the next launch is the reliability backstop. Both
BG request chains are already booked, with both OS preconditions off, because
`requiresNetworkConnectivity` would mean "has a LAN peer", which is a peer fact
and not an OS one.
