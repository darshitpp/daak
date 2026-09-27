import { createEngine } from '@daak/platform';
import type { DaakEngine } from '@daak/core';

export const engine: DaakEngine = createEngine();

export async function startEngine(): Promise<void> {
  await engine.start();
}
