import { useSyncExternalStore } from 'react';

export type SelfPresence = 'online' | 'away';

// In memory only. The engine keeps its own presence in memory too and starts
// as `online`, so both sides agree after every restart.
let current: SelfPresence = 'online';
const listeners = new Set<() => void>();

export const getSelfPresence = (): SelfPresence => current;

export function setSelfPresenceLocal(next: SelfPresence): void {
  if (next === current) return;
  current = next;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export const useSelfPresence = (): SelfPresence => useSyncExternalStore(subscribe, getSelfPresence, getSelfPresence);

