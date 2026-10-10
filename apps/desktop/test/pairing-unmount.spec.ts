import React, { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@daak/ui';
import { DesktopPairing } from '../src/pairing';

// The module under test imports the platform pairing facade at load time.
vi.mock('@daak/platform/src/pairing', () => ({ pairingBundle: vi.fn(async () => '{}') }));

type Handler = (event: { type: string; sas?: string; peerDeviceId?: string }) => void;

function fakeEngine() {
  const handlers = new Set<Handler>();
  return {
    handlers,
    on: (h: Handler) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    confirmPairing: vi.fn(async () => {}),
    revokePairing: vi.fn(async () => {}),
    armHostPairing: vi.fn(async () => {}),
  };
}

function mount(engine: ReturnType<typeof fakeEngine>): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      React.createElement(
        ToastProvider,
        null,
        // The engine fake has only the members that DesktopPairing calls.
        React.createElement(DesktopPairing, { engine: engine as never }),
      ),
    );
  });
  return tree;
}

const PEER = 'cc'.repeat(16);

describe('leaving the desktop pair route rejects a pending pairing', () => {
  it('revokes once, with the peer id, when it unmounts after a pairing.sas event', () => {
    const engine = fakeEngine();
    const tree = mount(engine);
    act(() => {
      for (const h of engine.handlers) h({ type: 'pairing.sas', sas: '004217', peerDeviceId: PEER });
    });
    // A re-render does not revoke.
    act(() => {
      tree.update(
        React.createElement(
          ToastProvider,
          null,
          React.createElement(DesktopPairing, { engine: engine as never }),
        ),
      );
    });
    expect(engine.revokePairing).not.toHaveBeenCalled();
    act(() => tree.unmount());
    expect(engine.revokePairing).toHaveBeenCalledTimes(1);
    expect(engine.revokePairing).toHaveBeenCalledWith(PEER);
  });

  it('does not revoke when it unmounts before any number', () => {
    const engine = fakeEngine();
    const tree = mount(engine);
    act(() => tree.unmount());
    expect(engine.revokePairing).not.toHaveBeenCalled();
  });

  it('unsubscribes from the engine on unmount', () => {
    const engine = fakeEngine();
    const tree = mount(engine);
    expect(engine.handlers.size).toBe(1);
    act(() => tree.unmount());
    expect(engine.handlers.size).toBe(0);
  });
});

