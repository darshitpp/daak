import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './strip-comments';

/**
 * The desktop dashboard shell is the only place that can hand the Settings,
 * thread, and window header inputs to DaakUiApp. A source pin proves the shell
 * forwards them. packages/ui tests prove what the screens do with them.
 * Comments are stripped, so prose can never satisfy a case.
 */
const shells = stripComments(readFileSync(join(__dirname, '..', 'src', 'shells.tsx'), 'utf8'));
const dashboard = shells.slice(
  shells.indexOf('export function DaakDashboardShell('),
  shells.indexOf('export function DaakTrayOverlay('),
);

describe('the desktop dashboard shell wires the Settings and window inputs', () => {
  it('passes the settings host, the Mac noun, and the window chrome', () => {
    expect(dashboard).toMatch(/\bsettingsHost\s*=\s*\{\s*settingsHost\s*\}/);
    expect(dashboard).toMatch(/\bdeviceNoun\s*=\s*"Mac"/);
    expect(dashboard).toMatch(/\bwindowChrome\s*=\s*\{\s*windowChrome\s*\}/);
    // Design v2: macOS names the Connection row "Network".
    expect(dashboard).toMatch(/\bnetworkLabel:\s*'Network'/);
  });

  // Settings revokes the pairing and then calls the hook. A host that revokes
  // too sends two requests for one tap.
  it('does not revoke a pairing itself', () => {
    expect(dashboard).not.toMatch(/\bonUnpair\s*=/);
    expect(dashboard).not.toMatch(/revokePairing/);
  });

  it('reads the version and the preferences through deep platform imports', () => {
    expect(shells).toMatch(/from '@daak\/platform\/src\/appinfo'/);
    expect(shells).toMatch(/from '@daak\/platform\/src\/notify-prefs'/);
    // The barrel resolves every TurboModule at module-eval time (index.js).
    expect(shells).not.toMatch(/from '@daak\/platform'/);
  });

  it('keeps the title and the version line in the window chrome', () => {
    expect(shells).toMatch(/title:\s*'Daak for Mac'/);
    expect(shells).toMatch(/formatAppInfo\(/);
  });
});

