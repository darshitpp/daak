import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeBgSpike } from './bg-spike.mjs';

test('passes when at least 60% of attempts run and queued work drains within 15 minutes', () => {
  const reconnectAt = 0;
  const records = [
    { taskId: 'dev.darshit.daak.processing', startedAt: 60_000, grantedMs: 30_000, dueAtStart: 3, drained: 3 },
    { taskId: 'dev.darshit.daak.refresh', startedAt: 300_000, grantedMs: 5_000, dueAtStart: 1, drained: 1 },
    { taskId: 'dev.darshit.daak.processing', startedAt: 900_000, grantedMs: 0, dueAtStart: 0, drained: 0 },
    { taskId: 'dev.darshit.daak.processing', startedAt: 1_200_000, grantedMs: 20_000, dueAtStart: 2, drained: 2 },
  ];
  const out = summarizeBgSpike(records, reconnectAt);
  assert.equal(out.attempts, 4);
  assert.equal(out.backgroundedRatio, 0.75);
  assert.equal(out.medianDrainDelayMs, 300_000);
  assert.equal(out.passes, true);
});

test('fails when the OS throttles every attempt', () => {
  const out = summarizeBgSpike([{ taskId: 'dev.darshit.daak.refresh', startedAt: 10, grantedMs: 0, dueAtStart: 4, drained: 0 }], 0);
  assert.equal(out.backgroundedRatio, 0);
  assert.equal(out.passes, false);
});
