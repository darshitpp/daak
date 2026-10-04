import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * react-test-renderer IS A DECLARED DEPENDENCY OF THIS PACKAGE.
 *
 * The defect this pins is not a bug in any line of code. gate-render.spec.ts and
 * tray-survival.spec.ts both import react-test-renderer, and for a while
 * NOTHING in apps/desktop/package.json said they were allowed to: it was absent
 * from devDependencies AND absent from the pnpm-lock.yaml importer block for
 * this package. It resolved anyway, because someone had hand-made
 * apps/desktop/node_modules/react-test-renderer as a symlink with an ABSOLUTE
 * path into the pnpm store.
 *
 * That is the worst kind of working. Every sibling link pnpm manages is relative
 * (../../../node_modules/.pnpm/...), so the absolute one is visible: it was not
 * made by pnpm, and `pnpm install --frozen-lockfile` would not recreate it. The
 * suite passed locally and would fail for a fresh clone, on CI, and on every
 * other machine -- with a module-resolution error that says nothing about the
 * real cause.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT: nothing in the repo can notice an
 * undeclared import. tsc resolves it through apps/desktop/types, vitest resolves
 * it through the stray symlink, and the RN preset is not even the thing that
 * brings it in (it is packages/ui's hoisting). Every tool agrees the import is
 * fine, which is exactly why the omission survived review. The one thing that
 * can catch it is a test that READS the two manifests and asks whether the
 * import is declared.
 *
 * WHY THE VERSION IS ASSERTED AGAINST THE OTHER IMPORTERS rather than written
 * out: a literal 18.3.1 here would pass just as happily if the workspace moved
 * to 18.3.2 everywhere else and this one package stayed behind -- the same class
 * of drift, one level up. So packages/ui is the reference, and if it moves this
 * test moves with it and says so.
 */

const DESKTOP = join(__dirname, '..');
const REPO = join(DESKTOP, '..', '..');

function manifest(pkgPath: string): { devDependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    devDependencies?: Record<string, string>;
  };
}

/** The version the rest of the workspace pins, which is the one to match. */
const PINNED = manifest(join(REPO, 'packages', 'ui', 'package.json')).devDependencies?.[
  'react-test-renderer'
];

/**
 * One importer block out of pnpm-lock.yaml, as raw text.
 *
 * Hand-sliced rather than parsed because the shape is fixed and a YAML parser
 * would be a NEW DEPENDENCY -- which is the exact category of change that caused
 * this round. An importer runs from `  <name>:` to the next line indented no
 * further, which is unambiguous here: importer names are the only keys at that
 * depth and everything under them is indented deeper.
 */
function importerBlock(lockfile: string, name: string): string {
  const lines = lockfile.split(String.fromCharCode(10));
  const start = lines.findIndex((line) => line === '  ' + name + ':');
  expect(start, 'pnpm-lock.yaml has no importer block for ' + name).toBeGreaterThanOrEqual(0);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    // A sibling importer, or the end of the importers section.
    if (/^ {0,2}[^ ]/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join(String.fromCharCode(10));
}

describe('react-test-renderer is declared, not merely resolvable', () => {
  it('is a devDependency of this package at the version the workspace pins', () => {
    // A reference that is itself missing would make every assertion below pass
    // vacuously, so it is checked first and by name.
    expect(PINNED, 'packages/ui must pin react-test-renderer; this is the reference').toBeDefined();

    const dev = manifest(join(DESKTOP, 'package.json')).devDependencies ?? {};
    expect(dev['react-test-renderer']).toBe(PINNED);
  });

  it('is declared in the pnpm-lock.yaml importer block for this package', () => {
    // The half that actually breaks a clean install. A package.json entry with
    // no importer entry makes `pnpm install --frozen-lockfile` fail outright
    // (ERR_PNPM_OUTDATED_LOCKFILE), and a lockfile entry with no package.json
    // entry is simply ignored -- so both halves are required and neither is
    // sufficient alone.
    const lockfile = readFileSync(join(REPO, 'pnpm-lock.yaml'), 'utf8');
    const block = importerBlock(lockfile, 'apps/desktop');
    expect(block).toContain('react-test-renderer:');
    // The specifier is the package.json string; the version is the resolved,
    // peer-suffixed id. Both are asserted because pnpm writes both, and a
    // hand-edit that gets one right and the other wrong is plausible and
    // completely invisible.
    expect(block).toContain('specifier: ' + PINNED);
    expect(block).toContain('version: ' + PINNED + '(react@' + PINNED + ')');
  });

  it('is still imported by the specs, so the declaration is not vestigial', () => {
    // The tie between the two halves of this file: the assertion above only
    // matters if something here actually imports the package. If the import
    // ever goes away the dependency should go with it, and this test says so
    // rather than letting a stale entry linger.
    const importers = readdirSync(join(DESKTOP, 'test'))
      .filter((name) => name.endsWith('.spec.ts'))
      .filter((name) =>
        readFileSync(join(DESKTOP, 'test', name), 'utf8').includes('react-test-renderer'),
      );
    expect(importers.length).toBeGreaterThan(0);
  });
});
