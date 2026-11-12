import React, { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@daak/ui';
import { DesktopPairing } from '../src/pairing';

// The module under test imports the platform pairing facade at load time.
vi.mock('@daak/platform/src/pairing', () => ({ pairingBundle: vi.fn(async () => '{}') }));

type Handler = (event: { type: string; sas?: string; peerDeviceId?: string }) => void;

function fakeEngine(confirm: () => Promise<void>) {
  const handlers = new Set<Handler>();
  return {
    handlers,
    on: (h: Handler) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    confirmPairing: vi.fn(confirm),
    revokePairing: vi.fn(async () => {}),
    codePairingSupported: true,
    cancelCodePairing: vi.fn(async () => {}),
    devices: vi.fn(async () => []),
    armHostPairing: vi.fn(async () => {}),
  };
}

function mount(engine: ReturnType<typeof fakeEngine>, onPaired: () => void): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(DesktopPairing, { engine: engine as never, onPaired }),
      ),
    );
  });
  return tree;
}

// React needs this flag before act() applies state updates.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PEER = 'cc'.repeat(16);

async function pressThey(tree: ReactTestRenderer, engine: ReturnType<typeof fakeEngine>) {
  // A real user presses Join a device first. The check number shows only after that.
  await act(async () => {
    ((tree.root as ReactTestInstance).findByProps({ testID: 'code-join' }).props as { onPress: () => void }).onPress();
  });
  act(() => {
    for (const h of engine.handlers) h({ type: 'pairing.sas', sas: '004217', peerDeviceId: PEER });
  });
  await act(async () => {
    ((tree.root as ReactTestInstance).findByProps({ testID: 'confirm' }).props as { onPress: () => void }).onPress();
  });
}

describe('the desktop pair screen leaves after the user confirms the number', () => {
  it('calls onPaired once after a confirmed pairing', async () => {
    const engine = fakeEngine(async () => {});
    const onPaired = vi.fn();
    const tree = mount(engine, onPaired);
    await pressThey(tree, engine);
    expect(engine.confirmPairing).toHaveBeenCalledWith(PEER);
    expect(onPaired).toHaveBeenCalledTimes(1);
  });

  it('does not call onPaired when the confirm fails', async () => {
    const engine = fakeEngine(async () => {
      throw new Error('no');
    });
    const onPaired = vi.fn();
    const tree = mount(engine, onPaired);
    await pressThey(tree, engine);
    expect(onPaired).not.toHaveBeenCalled();
  });
});
