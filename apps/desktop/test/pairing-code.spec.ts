import React, { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@daak/ui';
import { DesktopPairing } from '../src/pairing';

// The module under test imports the platform pairing facade at load time.
vi.mock('@daak/platform/src/pairing', () => ({ pairingBundle: vi.fn(async () => '{}') }));

type Handler = (event: { type: string; sas?: string; peerDeviceId?: string }) => void;

const ONLINE = 'aa'.repeat(16);
const TRUSTED = 'bb'.repeat(16);

function fakeEngine() {
  const handlers = new Set<Handler>();
  let armCount = 0;
  return {
    handlers,
    codePairingSupported: true,
    on: (h: Handler) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    confirmPairing: vi.fn(async () => {}),
    revokePairing: vi.fn(async () => {}),
    armHostPairing: vi.fn(async () => {}),
    armCodePairing: vi.fn(async () => {
      armCount += 1;
      return '482917';
    }),
    codePairingStatus: vi.fn(async () => ({ state: 'armed' as const, remainingMs: 120000, triesLeft: 5 })),
    cancelCodePairing: vi.fn(async () => {}),
    devices: vi.fn(async () => [
      { deviceId: TRUSTED, name: 'My phone', addr: '1.2.3.4:5', paired: true },
      { deviceId: ONLINE, name: 'Their Mac', addr: '1.2.3.4:6', paired: false },
    ]),
    pair: vi.fn(async () => ({ sas: '004217' })),
    selfProfile: vi.fn(async () => ({ name: 'My Mac', baseName: 'My Mac', deviceId: 'cc'.repeat(16) })),
    armCount: () => armCount,
  };
}

function mount(engine: ReturnType<typeof fakeEngine>): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(DesktopPairing, { engine: engine as never }),
      ),
    );
  });
  return tree;
}

function shown(tree: ReactTestRenderer): string {
  return JSON.stringify(tree.toJSON() ?? null);
}

async function press(tree: ReactTestRenderer, testID: string): Promise<void> {
  const node = tree.root.findByProps({ testID });
  act(() => {
    (node.props as { onPress?: () => void }).onPress?.();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function type(tree: ReactTestRenderer, testID: string, value: string): Promise<void> {
  const node = tree.root.findByProps({ testID });
  act(() => {
    (node.props as { onChangeText?: (v: string) => void }).onChangeText?.(value);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('the desktop code host', () => {
  it('arms a code, shows it, and polls after the arm resolves', async () => {
    const engine = fakeEngine();
    const tree = mount(engine);
    await press(tree, 'code-host');
    expect(engine.armCodePairing).toHaveBeenCalledTimes(1);
    // The six digit code is on screen, grouped by three.
    expect(shown(tree)).toContain('482 917');
    expect(engine.codePairingStatus).toHaveBeenCalled();
    expect(engine.selfProfile).toHaveBeenCalledTimes(1);
  });

  it('cancels the code when the panel closes', async () => {
    const engine = fakeEngine();
    const tree = mount(engine);
    await press(tree, 'code-host');
    await press(tree, 'pair-code-tab-enter');
    expect(engine.cancelCodePairing).toHaveBeenCalledTimes(1);
  });

  it('does not cancel when a new code replaces the old one', async () => {
    const engine = fakeEngine();
    const tree = mount(engine);
    await press(tree, 'code-host');
    await press(tree, 'pair-code-new');
    expect(engine.armCount()).toBe(2);
    expect(engine.cancelCodePairing).not.toHaveBeenCalled();
  });

  it('takes the code off the screen when the SAS arrives', async () => {
    const engine = fakeEngine();
    const tree = mount(engine);
    await press(tree, 'code-host');
    act(() => {
      for (const h of engine.handlers) h({ type: 'pairing.sas', sas: '004217', peerDeviceId: ONLINE });
    });
    expect(shown(tree)).not.toContain('482 917');
    expect(shown(tree)).toContain('confirm');
  });
});

describe('the desktop code joiner', () => {
  it('lists the unpaired peers and pairs once with the typed code', async () => {
    const engine = fakeEngine();
    const tree = mount(engine);
    await press(tree, 'code-join');
    // The trusted peer is removed from the picker.
    expect(shown(tree)).toContain('Their Mac');
    expect(shown(tree)).not.toContain('My phone');
    await press(tree, 'pair-code-pick-' + ONLINE);
    await type(tree, 'pair-code-input', '123456');
    await press(tree, 'pair-code-submit');
    expect(engine.pair).toHaveBeenCalledTimes(1);
    expect(engine.pair).toHaveBeenCalledWith(ONLINE, 'code', '123456');
  });
});
