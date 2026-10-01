import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Metro refused to build the desktop bundle at all:
//
//   Unable to resolve module node:path from apps/desktop/src/engine.ts
//
// A React Native bundle has no Node runtime. src/engine.ts used `join` for one
// POSIX join, and every OTHER module on the graph compiled fine only because
// nothing else reached for a builtin. There is no Node shim in
// react-native-macos, so this is a hard build failure, not a runtime one.
//
// Metro only reports the FIRST offender per run, so fixing engine.ts alone
// would have found the next one by another full rebuild. This walks the whole
// module graph reachable from the entry point instead.
const APP = join(__dirname, '..');

// Bare `path` resolves in Metro (it is aliased by the react-native preset) and
// fails at RUNTIME instead. Both spellings are the same defect, so both are out.
// The `/…` tail matters: `node:fs/promises` and `node:timers/promises` are real
// subpath builtins that a closed alternation would wave straight through.
const NODE_BUILTIN =
  /from\s+['"](?:node:)?(?:assert|buffer|child_process|cluster|crypto|dgram|diagnostics_channel|dns|domain|events|fs|http|http2|https|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|sys|timers|tls|trace_events|tty|url|util|v8|vm|wasi|worker_threads|zlib)(?:\/[^'"]*)?['"]/;

// Reachability, not a directory sweep: src/inbox.ts reads node:fs and is a
// REAL module with real callers in test/, but nothing in the running app
// imports it, so it is not in the bundle and cannot break the build. Asserting
// on it would be asserting about a file Metro never reads.
//
// Workspace-relative too (`@daak/core/...`), because that is how the app
// actually imports: the first version of this test only followed `./` specifiers
// and so missed `node:os` in packages/core/src/engine/DaemonClient.ts, which
// Metro then refused to build. Follow a bare `@daak/<pkg>` into the workspace.
const IMPORT = /from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g;

function resolveSpec(from: string, spec: string): string | undefined {
  if (spec.startsWith('.')) {
    const base = join(from, '..', spec);
    for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, 'index.ts')]) {
      if (existsSync(cand) && statSync(cand).isFile()) return cand;
    }
    return undefined;
  }
  // BOTH shapes: `@daak/core/src/engine/DaemonClient` AND the bare `@daak/ui`.
  // A regex that required a subpath silently stopped the walk at the first bare
  // workspace import, so the guard read 11 files instead of the real ~38 and
  // a `node:os` planted in packages/ui/src/headless.ts left it green.
  const ws = /^@daak\/([a-z-]+)(?:\/(.*))?$/.exec(spec);
  if (!ws) return undefined;
  const root = join(__dirname, '..', '..', '..', 'packages', ws[1], ws[2] ?? 'src/index');
  for (const cand of [root, `${root}.ts`, `${root}.tsx`, join(root, 'index.ts')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return undefined;
}

function graph(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const match of src.matchAll(IMPORT)) {
      const resolved = resolveSpec(file, match[1] ?? match[2]);
      if (resolved) queue.push(resolved);
    }
  }
  return [...seen];
}

describe('the desktop bundle reaches no Node builtin', () => {
  const files = graph(join(APP, 'index.js'));

  // This set was NOT empty. Found by this test on 2026-10-01:
  //
  //   packages/core/src/ipc/transport.ts      node:net  (connect, Socket)
  //   packages/core/src/engine/DaemonClient.ts node:os   (homedir)
  //
  // DaemonClientEngine is a NODE engine, and react-native-macos shims neither
  // builtin, so Metro could not BUILD the desktop bundle at all. Ruling D16.10.3
  // resolved it architecturally rather than by patching: macOS runs the engine
  // IN-PROCESS via UniFFI, so index.js no longer reaches DaemonClient. See
  // test/macos-inprocess-ffi.spec.ts and ledger D16.8/D16.10.3.
  //
  // Pinned as an EXACT set, so it cannot quietly regrow. Empty means empty: one
  // new offender fails the test below, which is the signal that the daemon
  // shape has leaked back onto the running app's module graph.
  const KNOWN_UNFIXABLE = new Set<string>();

  it('has files to check, so this cannot pass vacuously', () => {
    // 39, measured. The floor is not decorative: the first version of this walk
    // followed only `./` and bare-ish specifiers, stopped at `@daak/ui`, and read
    // 11 files while looking thorough. A `> 5` guard waves that through. If a
    // future resolver change shrinks the walk, fail here rather than reporting
    // a clean bill of health for a tenth of the bundle.
    expect(files.length).toBeGreaterThanOrEqual(35);
  });

  const offenders = files.filter((file) =>
    readFileSync(file, 'utf8').split('\n').some((line) => NODE_BUILTIN.test(line)),
  );

  it('has no Node builtin outside the two known-unfixable ones', () => {
    const unexpected = offenders.filter((f) => !KNOWN_UNFIXABLE.has(f));
    expect(
      unexpected.map((f) => f.replace(APP + '/', '')),
      'new Node builtin in the RN bundle — Metro will refuse to build',
    ).toEqual([]);
  });

  it('still has exactly zero documented offenders, no more and no fewer', () => {
    expect(offenders.map((f) => f.replace(APP + '/', '')).sort()).toEqual(
      [...KNOWN_UNFIXABLE].map((f) => f.replace(APP + '/', '')).sort(),
    );
  });
});
