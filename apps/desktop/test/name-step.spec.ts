import React, { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DesktopOnboardingFlow } from '../src/onboarding-flow';

/**
 * THE NAMING STEP, DRIVEN THE WAY A PERSON DRIVES IT.
 *
 * gate-render.spec.ts stops at the welcome screen. It never types. So the one
 * interaction a first launch cannot skip -- type a name, press Next -- had no
 * test at all, and a user reported that Next does nothing on macOS.
 *
 * Every other test here fires props directly. This one types into the field
 * with onChangeText and then presses Next, because that is the pair of calls a
 * keystroke and a click produce on the real runtime.
 */

function renderFlow(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(DesktopOnboardingFlow, {
        capabilities: {},
        onComplete: () => {},
      }),
    );
  });
  return renderer;
}

function text(tree: ReactTestRenderer): string {
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
describe('the welcome screen shows the words of the design', () => {
  it('uses the one heading, lead, and exits of the design', () => {
    const shown = text(renderFlow());
    expect(shown).toContain('Send anything to a phone next door');
    expect(shown).toContain('Photos, videos, documents and text go straight to another device on the same Wi-Fi.');
    expect(shown).toContain('Three things to know');
    expect(shown).toContain('It works offline');
    expect(shown).toContain('I already set this up');
  });

  it('shows none of the old macOS words', () => {
    const shown = text(renderFlow());
    expect(shown).not.toContain('Send a file to the room next door');
    expect(shown).not.toContain('Look around first');
    expect(shown).not.toContain('No internet, no sign-up, no waiting.');
  });

  // The design shows the wordmark on macOS too (macos.html, sc-welcome).
  it('shows the wordmark', () => {
    expect(text(renderFlow())).toContain('aak');
  });

  it('never imports the @daak/platform barrel', async () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'onboarding-flow.tsx'), 'utf8');
    expect(source).not.toMatch(/from '@daak\/platform'/);
  });
});

describe('the naming step accepts a typed name and advances', () => {
  it('shows the permissions step after Next is pressed with a name', async () => {
    const tree = renderFlow();
    await press(tree, 'welcome-get-started');
    await type(tree, 'name-input', 'Darshit MacBook');
    await press(tree, 'name-next');

    expect(tree.root.findByProps({ testID: 'screen-permissions' })).toBeTruthy();
    expect(text(tree)).not.toContain('screen-name-device');
  });

  /**
   * The negative, without which the test above passes for the wrong reason: a
   * flow stuck on welcome would also never show the permissions screen, but it
   * would fail the assertion above for a different reason. This pins that
   * Welcome advanced to the naming screen at all.
   */
  it('shows the naming step after Get started is pressed', async () => {
    const tree = renderFlow();
    await press(tree, 'welcome-get-started');
    expect(tree.root.findByProps({ testID: 'screen-name-device' })).toBeTruthy();
  });

  it('does not advance while the name is blank', async () => {
    const tree = renderFlow();
    await press(tree, 'welcome-get-started');
    await press(tree, 'name-next');
    expect(tree.root.findByProps({ testID: 'screen-name-device' })).toBeTruthy();
  });
});
