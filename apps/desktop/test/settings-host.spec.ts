import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './strip-comments';

const shells = stripComments(readFileSync(join(__dirname, '..', 'src', 'shells.tsx'), 'utf8'));
const dashboard = shells.slice(
  shells.indexOf('export function DaakDashboardShell('),
  shells.indexOf('export function DaakTrayOverlay('),
);

describe('the desktop dashboard shell wires the Settings inputs', () => {
  // Settings revokes the pairing and then calls the hook. A host that revokes
  // too sends two requests for one tap. The slice is DaakDashboardShell only.
  // DesktopPairing (src/pairing.tsx) revokes a pending pairing that the user
  // rejects, and that is the pairing flow, not the Settings Remove path.
  it('does not revoke a pairing itself', () => {
    expect(dashboard.length).toBeGreaterThan(0);
    expect(dashboard).not.toMatch(/\bonUnpair\s*=/);
    expect(dashboard).not.toMatch(/revokePairing/);
  });
});

