import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { attachPicker, desktopPickFiles } from '../src/picker';

// The desktop half of the injected picker. The composer's picker is INJECTED
// (packages/ui takes no TurboModule dependency), so the desktop shell has to
// HAND it one -- and that hand-off is invisible at runtime: a picker that never
// reaches the composer leaves "Add files" inert, which looks identical to a
// button that works.
//
describe('the desktop picker reaches the composer as a path list', () => {
  it('resolves the absolute paths the native panel returned', async () => {
    const seen: boolean[] = [];
    attachPicker(async (multiple) => {
      seen.push(multiple);
      return ['/Users/d/Documents/a.pdf'];
    });
    await expect(desktopPickFiles(true)).resolves.toEqual(['/Users/d/Documents/a.pdf']);
    expect(seen).toEqual([true]);
  });

  it('passes the multiple flag straight through to NSOpenPanel', async () => {
    const seen: boolean[] = [];
    attachPicker(async (multiple) => {
      seen.push(multiple);
      return [];
    });
    await desktopPickFiles(false);
    expect(seen).toEqual([false]);
  });

  // A CANCELLED panel resolves with an empty array (RNShare.mm), so this arm is
  // the normal one and must pass through untouched. It is pinned because a
  // wrapper that rejected on empty -- "nothing was picked" is not an error --
  // would surface as a red box in the shipped app over a Cancel click.
  it('passes an empty list through as an empty list', async () => {
    attachPicker(async () => []);
    await expect(desktopPickFiles(true)).resolves.toEqual([]);
  });
});

// The shell hand-off, asserted on SOURCE because apps/desktop has no React
// renderer (no react-test-renderer/@testing-library in its node_modules, and
// vitest's include is test/**/*.spec.ts -- no .tsx). Every desktop spec is a
// .ts, so this is the house style, and the same trade test/rn-bundle-purity
// makes. What is being pinned is a prop chain that a typo anywhere along it
// silently breaks at runtime.
//
// Comments are stripped first (R95): shells.tsx explains the tray ownership and
// the direct-share store at length, and a source pin that can be satisfied by
// prose is decoration.
const strip = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const shells = strip(readFileSync(join(__dirname, '..', 'src', 'shells.tsx'), 'utf8'));
const index = strip(readFileSync(join(__dirname, '..', 'index.js'), 'utf8'));
// Scoped to ONE root's own text. The whole-file regex this replaces was
// satisfied by the POPOVER root's onPickFiles={desktopPickFiles}, so the
// dashboard's prop could be any identifier at all -- including a named no-op,
// which is how all 8 tests here stayed green over a composer that opened no
// panel. The dashboard root is the one that renders the composer, so its own
// substring is the only place this prop is load-bearing.
const componentSource = (name: string): string => {
  const at = shells.indexOf(`function ${name}(`);
  expect(at).toBeGreaterThan(-1);
  const rest = shells.slice(at);
  // Brace-balance from the BODY, not the parameter destructuring: the
  // signature's own { engine, runtime } closes immediately and would capture
  // just the parameter list.
  let parens = 0;
  let bodyAt = -1;
  for (let i = rest.indexOf('('); i < rest.length; i += 1) {
    if (rest[i] === '(') parens += 1;
    else if (rest[i] === ')') parens -= 1;
    if (parens === 0 && rest[i + 1] === '{') { bodyAt = i + 1; break; }
  }
  expect(bodyAt).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = bodyAt; i < rest.length; i += 1) {
    if (rest[i] === '{') depth += 1;
    else if (rest[i] === '}' && --depth === 0) return rest.slice(0, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
};
const dashboard = componentSource('DaakDashboardShell');

describe('the desktop shell hands the picker to the composer', () => {
  it('passes onPickFiles down from the dashboard shell to DaakUiApp', () => {
    // The dashboard root is the one that renders the composer; the popover root
    // has none, so threading it there would be a prop nothing reads.
    // BY NAME, not just "some identifier": the dashboard's prop has to BE the
    // picker, which is what index.js attaches at startup. A named no-op is
    // exactly the shape that hid here, and an inline `onPickFiles={() => {}}` is
    // the dead callback apps/mobile/src/__tests__/sendAndTransfersRoute.test.tsx
    // exists to hunt.
    expect(dashboard).toMatch(/onPickFiles=\{\s*desktopPickFiles\s*\}/);
    // exactly once, so nothing else inside the slice can stand in for it.
    expect(dashboard.match(/onPickFiles=/g)?.length ?? 0).toBe(1);
  });

  it('attaches the native panel at startup, next to the other attach calls', () => {
    // attachPicker must run in index.js, above both roots: a picker attached
    // after AppRegistry.registerComponent would race the first render of the
    // dashboard window, which is built at launch.
    expect(index).toMatch(/attachPicker\(/);
    // Deep import, never the @daak/rn-share barrel -- the barrel default-exports
    // a getEnforcing('DaakShare') that throws on macOS, where only Daak and
    // DaakSystemShare are registered. Same rule index.js:5-13 records for
    // @daak/platform, and test/rn-bundle-purity.spec.ts would only catch the
    // Node-builtin half of it.
    expect(index).not.toMatch(/from\s+'@daak\/rn-share'/);
    expect(index).not.toMatch(/from\s+'@daak\/platform'/);
  });

  // The bug this pins is an INFINITE RECURSION, and it is invisible from the
  // three tests above because they attach their own implementation and never
  // read the default. In index.js the attached value has to be the function
  // that requires NSOpenPanel's module; attaching the wrapper instead makes the
  // wrapper call itself forever on the first "Add files" click, so the
  // dashboard hangs with no error anywhere.
  it('attaches the NATIVE implementation, not the wrapper that calls it', () => {
    expect(index).toMatch(/attachPicker\(nativeDesktopPickFiles\)/);
    expect(index).not.toMatch(/attachPicker\(desktopPickFiles\)/);
  });
});

// Same hand-off shape as the picker, for the Inbox row's Share verb: injected,
// and silently absent if the chain breaks. The buttons render only when the
// host supplied the actions, so a dropped prop produces a row with no Share --
// no error, no log, nothing to notice in a smoke test.
describe('the desktop shell hands native actions to the Inbox rows', () => {
  it('passes inboxActions from the dashboard shell to DaakUiApp', () => {
    // The dashboard is the only root with an Inbox; the popover has none.
    expect(shells).toMatch(/inboxActions=\{[a-zA-Z]+\}/);
    expect(shells).not.toMatch(/inboxActions=\{\s*\{\}\s*\}/);
  });

  // An engine that never started leaves every list empty with nothing on
  // screen saying why -- the menu says "nothing paired" and looks healthy.
  // Mobile got this in apps/mobile/src/App.tsx; desktop must not be the odd one.
  it('reports a failed start on screen, not only in the log', () => {
    expect(index).toMatch(/reportStartFault\(/);
    expect(shells).toMatch(/StartFaultNote/);
  });
});
