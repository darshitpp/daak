import React, { createContext, useContext } from 'react';
import type { DaakEngine } from '@daak/core';

const Ctx = createContext<DaakEngine | null>(null);

export function EngineProvider({ engine, children }: { engine: DaakEngine; children: React.ReactNode }) {
  return <Ctx.Provider value={engine}>{children}</Ctx.Provider>;
}

export function useEngine(): DaakEngine {
  const engine = useContext(Ctx);
  if (!engine) throw new Error('useEngine must be used inside <EngineProvider>');
  return engine;
}
