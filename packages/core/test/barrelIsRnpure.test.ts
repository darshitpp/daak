import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

// On 2026-10-01 this was the second of two bundle-time failures that no test
// suite could see. The app was installed on a booted iOS simulator, and Metro
// answered /index.bundle with HTTP 500:
//
//   Unable to resolve module node:net from packages/core/src/ipc/transport.ts
//
// Because the mobile app reaches @daak/core through its BARREL, and the barrel
// did `export * from './ipc/transport'`, every iOS and Android launch pulled a
// desktop-only module that speaks raw TCP to the daakd socket. The barrel's own
// comment above the NativeDaak export already said Node code must deep-import;
// this test makes the rule total instead of advisory.
//
// It walks the RELATIVE import graph from index.ts. Metro follows the same
// edges, so anything this reaches with a `node:` specifier is a guaranteed red
// box on device, on every platform, before any app code runs.
const indexTs = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts');

function resolveRelative(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec);
  for (const cand of [`${base}.ts`, `${base}/index.ts`]) {
    if (existsSync(cand)) return cand;
  }
  return undefined;
}

function reachable(): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue = [indexTs];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
      const specs: string[] = [];
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        // BOTH quote styles and bare `import 'x'` side-effect imports. A regex
        // that only matched single quotes let `import "node:fs"` through, which
        // is the same defect as the one this file exists to prevent.
        const m = /(?:from|import|require\()\s*(?:'([^']+)'|"([^"]+)")/.exec(line);
        if (m) specs.push(m[1] ?? m[2]);
    }
    seen.set(file, specs);
    for (const spec of specs) {
      if (!spec.startsWith('.')) continue;
      const next = resolveRelative(file, spec);
      if (next) queue.push(next);
    }
  }
  return seen;
}

describe('the @daak/core barrel stays loadable in a React Native bundle', () => {
  it('still exports what the mobile app imports from it', () => {
    // Without this, EMPTING the barrel satisfies the walk below trivially: one
    // file with no imports reaches nothing and the guard passes. A guard that
    // cannot fail is not a guard, so pin the two value exports the RN runtime
    // path actually needs before checking that reaching them costs nothing.
    const src = readFileSync(indexTs, 'utf8');
    expect(src).toMatch(/export .*\bInProcessEngine\b/);
    expect(src).toMatch(/export .*\bNativeDaak\b/);
  });

  it('reaches no node: builtin from index.ts', () => {
    const offenders: string[] = [];
    for (const [file, specs] of reachable()) {
      for (const spec of specs) {
        if (spec.startsWith('node:')) offenders.push(`${file} imports ${spec}`);
      }
    }
    // DaemonClient + ipc/transport + node:net/node:os are DESKTOP. Desktop code
    // deep-imports them (apps/desktop/src/engine.ts), which is why nothing in
    // the desktop app needs them here.
    expect(offenders).toEqual([]);
  });
});
