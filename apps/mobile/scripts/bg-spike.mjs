// The two BGTaskScheduler identifiers this app registers. Duplicated in
// packages/platform/src/bgsched.ts, Info.plist and DaakBgLaunch.swift because
// none of the four can import the others; pinned by backgroundExec.test.ts.
export const BG_TASKS = ['dev.darshit.daak.refresh', 'dev.darshit.daak.processing'];

// WHY `drained` and `dueAtStart` CANNOT BE FILLED TODAY: a BGTask is launched by
// the OS into a process whose JS bridge may not exist, so the producer (the
// launch handler) has no way to read the Rust outbox row count. The analyzer
// still reads the other two fields so a future real run measures the whole
// criterion; on a real iOS log today the median is therefore always null and
// `passes` is always false. See apps/mobile/ios/BgSpike/README.md.
//
// `grantedMs` IS ALSO 0 for every real record today: the handler is a no-op
// (it completes and reschedules), so the measured window truncates to zero, and
// `backgroundedRatio` is 0. The number a real run can actually report is
// `attempts` -- how many times in 24h the OS granted a slot at all -- which is
// the honest half of "background realism". The threshold stays as the plan
// wrote it so a run becomes comparable when a real grant body exists.
export function summarizeBgSpike(records, reconnectAt) {
  const attempts = records.length;
  if (attempts === 0) return { attempts: 0, backgroundedRatio: 0, medianDrainDelayMs: null, passes: false };
  const backgrounded = records.filter((r) => r.grantedMs > 0).length;
  const delays = records
    .filter((r) => r.dueAtStart > 0 && r.drained > 0)
    .map((r) => Math.max(0, r.startedAt - reconnectAt))
    .sort((a, b) => a - b);
  const medianDrainDelayMs = delays.length === 0 ? null : delays[Math.floor(delays.length / 2)];
  const passes = backgrounded / attempts >= 0.6 && medianDrainDelayMs !== null && medianDrainDelayMs <= 15 * 60 * 1000;
  return { attempts, backgroundedRatio: backgrounded / attempts, medianDrainDelayMs, passes };
}

if (process.argv[1] && process.argv[1].endsWith('bg-spike.mjs')) {
  const fs = await import('node:fs/promises');
  const records = (await fs.readFile(process.argv[2], 'utf8'))
    .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const reconnectAt = Number(process.env.RECONNECT_AT ?? 0);
  console.log(JSON.stringify(summarizeBgSpike(records, reconnectAt), null, 2));
}
