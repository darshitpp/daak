import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { DaakUiApp } from './App';
import { createUiRuntime } from './headless';
import { fakeEngine } from './testing/fakeEngine';
import type { UiState } from './state/store';
import type { DaakEvent } from '@daak/core';

describe('DaakUiApp', () => {
  it('renders the popover from the folded state', () => {
    const engine = fakeEngine();
    const bus = (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers;
    const runtime = createUiRuntime(engine);
    render(<DaakUiApp mode="popover" engine={engine} runtime={runtime} />);
    act(() => {
      bus.forEach((h) => h({ type: 'device.discovered', device: { deviceId: 'a', name: 'A', addr: '1.2.3.4:1' } }));
    });
    expect(screen.getByText('A')).toBeTruthy();
  });

  // finding 8: useSyncExternalStore resubscribes whenever `subscribe` changes
  // identity, and an inline arrow changed on every render the event caused.
  it('does not resubscribe once per event', () => {
    const engine = fakeEngine();
    const bus = (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers;
    const runtime = createUiRuntime(engine);
    let subscribes = 0;
    const counting: typeof runtime = {
      getState: runtime.getState,
      prime: runtime.prime,
      subscribe: (l: (s: UiState) => void) => {
        subscribes += 1;
        return runtime.subscribe(l);
      },
    };
    render(<DaakUiApp mode="popover" engine={engine} runtime={counting} />);
    expect(subscribes).toBe(1);
    for (let i = 0; i < 3; i += 1) {
      act(() => {
        bus.forEach((h) => h({ type: 'inbox.received', payload: { payloadId: String(i) } as never }));
      });
    }
    expect(subscribes).toBe(1);
  });
});
