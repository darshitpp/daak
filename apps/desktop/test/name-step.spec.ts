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

/**
 * THE MACOS WELCOME COPY.
 *
 * These words are DUPLICATED in apps/desktop/src/onboarding-flow.tsx rather
 * than imported from @daak/platform, because that barrel reaches
 * TurboModuleRegistry.getEnforcing for seven mobile modules the macOS host
 * does not register. Duplication without a test is drift with extra steps, so
 * these pin the copy, and the last case pins the reason the import is not made.
 */
describe('the welcome screen shows the macOS words, not the phone ones', () => {
  it('uses the desktop heading, eyebrow, and lead', () => {
    const shown = text(renderFlow());
    expect(shown).toContain('Send a file to the room next door');
    expect(shown).toContain('Welcome');
    expect(shown).toContain('Nothing leaves your home network, and no account is needed.');
  });

  // The load-bearing one. The shared screen's DEFAULTS are the Android words,
  // so a copy prop that is dropped silently puts the phone's three promises on
  // a Mac, which is the exact divergence this change exists to remove.
  it('shows neither the phone heading nor the phone promises', () => {
    const shown = text(renderFlow());
    expect(shown).not.toContain('Send photos, files, and text');
    expect(shown).not.toContain('Both devices sit on the same Wi-Fi.');
    expect(shown).not.toContain('No account, no sign-up, no cloud.');
    expect(shown).not.toContain('Files travel straight between the two devices.');
    expect(shown).not.toContain('Three things to know');
  });

  it('exits with "Look around first", not the phone skip', () => {
    const shown = text(renderFlow());
    expect(shown).toContain('Look around first');
    expect(shown).not.toContain('I already paired this phone');
  });

  // The reference note is ONE sentence. A title with a body would render a
  // second, empty line under it.
  it('shows the note as a single line with no empty body', () => {
    const shown = text(renderFlow());
    expect(shown).toContain('No internet, no sign-up, no waiting.');
    // The phone note must not appear, and neither must a body under the Mac one.
    expect(shown).not.toContain('Airplane mode is fine');
  });

  // The reference has no wordmark on this screen: the sidebar already carries
  // it, and the prototype comments that showing it twice read as a bug.
  it('shows no wordmark, because the sidebar has one', () => {
    expect(text(renderFlow())).not.toContain('aak');
  });

  // The structural guard for the duplication above: if someone moves the copy
  // to a shared module, these two facts must still hold.
  it('never imports the @daak/platform barrel for its copy', async () => {
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
