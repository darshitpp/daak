import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The shell wiring for "Send with Daak". Source-text checks, because no test
// renders DaakDashboardShell. The send logic has its own test on the store.
const shells = readFileSync(join(__dirname, '..', 'src', 'shells.tsx'), 'utf8');
const store = readFileSync(join(__dirname, '..', 'src', 'service-files.ts'), 'utf8');

// The source text of one shell function, up to the next top-level export.
function body(name: string): string {
  const start = shells.indexOf(`export function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = shells.indexOf('\nexport ', start + 1);
  const rest = next === -1 ? shells.slice(start) : shells.slice(start, next);
  // Drop the module-level code after the shell, such as TrayOverlay.
  const tray = rest.indexOf('\nconst TrayOverlay');
  return tray === -1 ? rest : rest.slice(0, tray);
}

const dashboard = body('DaakDashboardShell');
const popover = body('DaakPopoverShell');

describe('the dashboard shell wires the Finder service files', () => {
  it('reads the store with useSyncExternalStore', () => {
    // A stable useCallback wraps subscribeServiceFiles, as the peer store does.
    expect(dashboard).toMatch(
      /useCallback\(\s*\(onChange: \(\) => void\)\s*=>\s*subscribeServiceFiles\(onChange\)\s*,\s*\[\]\s*,?\s*\)/,
    );
    expect(dashboard).toMatch(/useSyncExternalStore\(\s*subscribeSvc\s*,\s*getServiceFiles\s*\)/);
  });

  it('passes the files and the token to the dashboard DaakUiApp only', () => {
    const el = dashboard.match(/<DaakUiApp[\s\S]*?\/>/);
    expect(el).not.toBeNull();
    expect(el![0]).toMatch(/mode="dashboard"/);
    expect(el![0]).toMatch(/initialFiles=\{svc\?\.files\}/);
    expect(el![0]).toMatch(/initialShareToken=\{svc\?\.token\}/);
    expect(popover).not.toMatch(/initialFiles|initialShareToken|onShareSend|onCancelShare/);
  });

  it('sends through sendServiceFiles and cancels through consumeServiceFiles', () => {
    const el = dashboard.match(/<DaakUiApp[\s\S]*?\/>/)![0];
    expect(el).toMatch(
      /onShareSend=\{\(\s*d\s*,\s*share\s*\)\s*=>\s*sendServiceFiles\(\s*engine\s*,\s*d\s*,\s*share\s*\)\}/,
    );
    expect(el).toMatch(/onCancelShare=\{consumeServiceFiles\}/);
  });

  it('calls onServiceFiles inside a useEffect that returns the cleanup', () => {
    expect(dashboard).toMatch(
      /useEffect\(\(\)\s*=>\s*\{[^}]*return onServiceFiles\(\);\s*\},\s*\[\]\s*\)/,
    );
  });

  it('does not call onServiceFiles from index.js', () => {
    const index = readFileSync(join(__dirname, '..', 'index.js'), 'utf8');
    expect(index).not.toMatch(/onServiceFiles/);
  });
});
