import { readFileSync } from 'fs';
import { join } from 'path';

// No JVM test source set in this module and no Android SDK in CI, so this is a
// source-level pin, not a behavioural test -- the same accepted pattern as
// shareTargetManifest.test.ts. The failure it guards is not subtle:
// minSdkVersion is 24, while ShortcutManager's class overload, Person, setPerson
// and maxShortcutCountPerActivity are all API 30. Touching one of those on a
// API-29 device is a NoSuchMethodError out of startEngine, on every launch.
//
// Not vacuous: every assertion is a position comparison against the guard's
// early-return line, so deleting the guard, dropping the return, or hoisting an
// API-30 symbol above the guard each fails a different test here.
const KT = join(
  __dirname,
  '../../android/app/src/main/java/dev/darshit/daak/shortcuts/DirectShareShortcuts.kt',
);
const lines = readFileSync(KT, 'utf8').split('\n');

/** Every Android symbol that does not exist below API 30. */
const API_30_ONLY = [
  'ShortcutManager',
  'Person.Builder',
  'setPerson',
  'maxShortcutCountPerActivity',
  'setDynamicShortcuts',
  'ShortcutInfo.Builder',
  'CATEGORY_CONVERSATION',
];

const RE_GUARD = /SDK_INT\s*<\s*Build\.VERSION_CODES\.R/;
const RE_BARE_RETURN = /^\s*return\s*$/;
const RE_IMPORT = /^\s*import\s/;

/** Line index of the guard's early-return line, or -1 if the guard is gone. */
function guardReturnIndex(): number {
  const guard = lines.findIndex((l) => RE_GUARD.test(l));
  if (guard === -1) return -1;
  return lines.findIndex((l, i) => i > guard && RE_BARE_RETURN.test(l));
}

describe('DirectShareShortcuts API-level guard (R29)', () => {
  it('has exactly one SDK_INT guard, and its body is an early return', () => {
    expect(lines.filter((l) => l.includes('SDK_INT'))).toHaveLength(1);
    expect(guardReturnIndex()).toBeGreaterThan(-1);
  });

  it('uses no API-30 symbol above the guard return', () => {
    const guard = guardReturnIndex();
    expect(guard).toBeGreaterThan(-1);
    // Imports sit above the guard and are safe: an import is a name, not a
    // resolved class (ART resolves lazily). So is a String const. Any OTHER
    // mention above the return is the crash.
    const above = lines.slice(0, guard).filter((l) => !RE_IMPORT.test(l));
    for (const symbol of API_30_ONLY) {
      for (const l of above) {
        if (!l.includes(symbol)) continue;
        // A declaration (`private const val CATEGORY = "android..."`) and a
        // comment mentioning the symbol are both fine; an expression is not.
        const RE_DECL = /^\s*(private\s+)?const\s+val\s+\S+\s*=/;
        const trimmed = l.trim();
        const isComment =
          trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
        const harmless = RE_DECL.test(l) || isComment;
        if (!harmless) {
          throw new Error(`API-30 symbol ${symbol} used above the guard: ${l.trim()}`);
        }
      }
    }
  });

  it('builds the brief-specified shortcut inside the guarded region', () => {
    const body = lines.slice(guardReturnIndex()).join('\n');
    expect(body).toContain('ShortcutManager');
    expect(body).toContain('Person.Builder');
    expect(body).toContain('daak.send.');
    // The literal lives in the const above the guard (a String is not an API
    // symbol); its USE must be below the return.
    expect(body).toContain('setCategories(setOf(CATEGORY_CONVERSATION))');
    expect(body).toContain('.setLongLived(true)');
    expect(body).toContain('"daak.target_device"');
  });

  // The peer list is published on every API level and on iOS, so the module
  // must reach sync() with no SDK check and must RESOLVE either way. A guard
  // that REJECTED below API 30 would turn a missing feature into a red screen,
  // and the caller here is startEngine, on the launch path.
  it('never rejects below API 30: the module calls sync with no SDK check', () => {
    const mod = readFileSync(
      join(
        __dirname,
        '../../../../modules/rn-share/android/src/main/java/dev/darshit/daak/share/DaakShareModule.kt',
      ),
      'utf8',
    );
    const fn = mod.slice(
      mod.indexOf('override fun updateShortcutTargets'),
      mod.indexOf('private fun parseDevices'),
    );
    expect(fn).toContain('sync.invoke');
    expect(fn).not.toContain('SDK_INT');
    expect(fn).toContain('promise.resolve(null)');
  });
});
