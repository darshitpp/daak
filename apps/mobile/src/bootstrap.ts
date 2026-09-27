import { createEngine } from '@daak/platform';
import type { DaakEngine } from '@daak/core';

export const engine: DaakEngine = createEngine();

// Nothing calls this yet: app-level lifecycle (mount the effect, retry on
// failure) is a later Phase 5 task. Until then `engine` is constructed eagerly
// at import, so the TurboModule is resolved but never started.
export async function startEngine(): Promise<void> {
  await engine.start();
}
