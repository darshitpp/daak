import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The panel is 320 px wide in the design (macos-menubar.html, `.pop`). The native
// popover and the React root must agree. A native shell cannot run in vitest, so
// this test reads the sources.
const root = join(__dirname, '..', '..', '..');
const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8');

describe('the menu-bar panel width', () => {
  it('sets the native popover to 320 points wide', () => {
    const host = read('modules', 'rn-tray', 'macos', 'RNWindowHost.mm');
    expect(host).toMatch(/popover\.contentSize\s*=\s*NSMakeSize\(\s*320\s*,\s*\d+\s*\)/);
    expect(host).not.toMatch(/NSMakeSize\(\s*360\s*,/);
  });

  it('makes the React root of the panel 320 wide', () => {
    const panel = read('packages', 'ui', 'src', 'modes', 'Popover.tsx');
    expect(panel).toMatch(/width:\s*320/);
  });

  it('tells the panel which noun to use', () => {
    const shells = read('apps', 'desktop', 'src', 'shells.tsx');
    const body = shells.slice(shells.indexOf('export function DaakPopoverShell'), shells.indexOf('export function DaakDashboardShell'));
    expect(body).toMatch(/mode="popover"[\s\S]*deviceNoun="Mac"/);
  });
});
