import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// macOS runs the engine IN-PROCESS, not as an IPC client of daakd.
//
// Ruling D16.10.3 (2026-10-01): the daemon shape was dropped for macOS. It is
// not a preference -- apps/desktop/index.js reached
// DaemonClientEngine.connect(socketPath), which pulls in node:net and node:os,
// and react-native-macos shims neither, so Metro refused to BUILD the bundle at
// all. In-process reuses the Daak TurboModule mobile already has, which needs no
// new native module.
//
// This file pins the parts that are silently wrong if they regress. Each one of
// them produced or would produce a macOS app whose UI renders perfectly over a
// DEAD engine, which is the single failure mode this project keeps hitting:
// 943ac70 shipped Android that way, and D16.10.1 had to prove iOS by finding a
// bound socket rather than by absence of a redbox.
const APP = join(__dirname, '..');
const MACOS = join(APP, 'macos');

// Swift comments are stripped before anything in this file asserts on a
// KeychainSecureStore or Daak.swift identifier. Both files EXPLAIN these exact
// identifiers in prose -- baseQuery's comment names kSecUseAuthenticationUI and
// kSecAttrAccessibleWhenUnlocked, Daak.swift's names
// SecKeychainSetUserInteractionAllowed -- so an unstripped `toContain` is
// satisfied by the essay explaining the decision, not by the code making it.
// That is not hypothetical: an earlier revision of this spec asserted
// 'kSecUseAuthenticationUIFail' over the raw file, and the flag's real
// dictionary entry could be deleted while the comment above it still said the
// word. Stripping is what makes a count mean something, and a count is what
// makes a DECISION structural: a token that must appear exactly once cannot be
// quietly reintroduced on a second code path, and a token that must appear zero
// times cannot be reintroduced at all.
const stripSwiftComments = (s: string): string => s.replace(/\/\/.*$/gm, '');

// The offset of the line on which `needle` occurs, searching `from` forward.
// Needed wherever a claim is about the LINE a token sits on -- 'the one
// errSecItemNotFound arm', 'the one kSecAttrAccessible entry' -- because the
// same file uses that token elsewhere for an unrelated reason, and a plain
// 'does not appear' would then be wrong rather than strict.
const lineAt = (src: string, needle: string, from = 0): string => {
  const at = src.indexOf(needle, from);
  if (at === -1) throw new Error(`expected to find ${needle}`);
  return src.slice(src.lastIndexOf('\n', at) + 1, src.indexOf('\n', at));
};

// End offset of the brace-balanced block that opens at/after `openAt`.
// Nesting matters here: the interesting block is `q.async { do { ... } }`, so a
// flat indexOf of the next '}' lands on the do-block's close and truncates the
// range -- which is how a defer ends up 'outside its own block' while the
// assertion says otherwise.
const blockEndAt = (src: string, openAt: number): number => {
  let depth = 0;
  for (let i = src.indexOf('{', openAt); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return i;
  }
  throw new Error('unbalanced braces from ' + openAt);
};

// Offset of the nearest `case <errSecStatus>` label ABOVE `from`, reached only
// through statement runs that cannot LEAVE their arm -- i.e. a run with no
// `return`, `break` or `throw` in it. Returns -1 when no earlier label can reach
// `from` that way.
//
// This exists because 'the case label above the return' is the wrong question.
// A Swift arm that ends in `return` is unreachable from the label above it, so
// walking backwards from a `return nil` and collecting the labels whose runs
// carry no exit gives exactly the statuses that can reach that nil. A
// `fallthrough` is itself an exit, and it is the one exit that does NOT end the
// arm, so it is deliberately absent from the blocked set: the walk CONTINUES
// past it into the label above, which is precisely the label that reaches the
// nil by falling through. `break` and `return` in a Swift switch are both arms
// of the same thing -- both exit the switch -- so both block; `throw` blocks too.
// Anything these do not name also blocks, so a source form this walk does not
// understand cannot pass as 'reachable'.
const lastLabelBefore = (src: string, from: number): number => {
  const at = [...src.slice(0, from).matchAll(/case\s+errSec\w+/g)].pop();
  if (!at) return -1;
  return /\b(return|break|throw)\b/.test(src.slice(at.index!, from)) ? -1 : at.index!;
};

describe('macOS runs the engine in-process', () => {
  it('the entry point builds its engine in-process, not over IPC', () => {
    const index = readFileSync(join(APP, 'index.js'), 'utf8');
    // IMPORTS, not raw text. Both symbols are named in the comment above the
    // engine construction, deliberately, to explain what was replaced and why;
    // a substring check over the whole file therefore fails on the explanation
    // and would push someone to delete the history. What must not come back is
    // an IMPORT, because that is what puts node:net on the bundle graph.
    const imports = [...index.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gm)].map((m) => m[1]);
    expect(imports).not.toContain('./src/engine');
    // The in-process engine is the one @daak/platform already builds for
    // mobile, so the two apps cannot drift in how they talk to the engine.
    // The DEEP specifier, not the barrel: packages/platform/src/index.ts
    // re-exports bgsched/clipboard/fspaths/qr/securestore/share, each of which
    // calls TurboModuleRegistry.getEnforcing() at module-eval time, and macOS
    // registers none of those six -- only Daak, DaakSystemShare,
    // DaakSystemNotify and the desktop window/tray modules. The barrel is an
    // eager throw before the first render; the deep path touches only 'Daak'.
    expect(imports).toContain('@daak/platform/src/engine');
  });

  it('the engine module no longer reaches a Node builtin', () => {
    // src/engine.ts is what broke the bundle. It keeps daakSocketPath as an
    // exported, tested helper for the daemon shape Phase 8 may bring back, but
    // nothing on the running app's graph may call it.
    const engine = readFileSync(join(APP, 'src', 'engine.ts'), 'utf8');
    expect(engine).not.toMatch(/from\s+['"](?:node:)?(?:net|os|path)['"]/);
  });

  it('the Daak TurboModule is registered natively on macOS', () => {
    // Without the Swift class there is no engine and getEnforcing throws at
    // module-eval time, before any of this app's code runs.
    const swift = join(MACOS, 'Daak-macOS', 'Daak.swift');
    expect(existsSync(swift)).toBe(true);
    const src = readFileSync(swift, 'utf8');
    expect(src).toContain('@objc(Daak)');
    expect(src).toContain('import daak_ffiFFI');
  });

  it('the method table declares every method the UDL exposes', () => {
    // DaakModule.mm is a hand-written mirror of crates/daak-ffi/src/daak.udl.
    // A method missing here compiles, links, and then fails only at runtime as
    // an unrecognized selector, which is the mobile cac91f1 bug class.
    const mm = readFileSync(join(MACOS, 'Daak-macOS', 'DaakModule.mm'), 'utf8');
    expect(mm).toContain('RCT_EXTERN_MODULE(Daak, RCTEventEmitter)');
    for (const m of [
      'start:',
      'pairingBundle:',
      'offerPairing:',
      'armHostPairing:',
      'pairWith:',
      'acceptPairing:',
      'sendText:',
      'sendFiles:',
      'listDevices:',
      'cancel:',
      'retry:',
      'listTransfers:',
      'listThread:',
      'listInbox:',
      'setDisplayName:',
      'setPresence:',
      'localPort:',
      'shutdown:',
    ]) {
      expect(mm).toContain(m);
    }
  });

  it('the keychain store uses the data-protection keychain, always', () => {
    // Without kSecUseDataProtectionKeychain, SecItem writes land in the LEGACY
    // file-based keychain, which is what produces a password prompt in front of
    // an app the user never gave a credential to.
    const store = join(MACOS, 'Daak-macOS', 'KeychainSecureStore.swift');
    expect(existsSync(store)).toBe(true);
    const src = readFileSync(store, 'utf8');
    expect(src).toContain('kSecUseDataProtectionKeychain');

    // ALWAYS, not conditionally. The single-flag probe was a silent downgrade to
    // the LEGACY file keychain, which is the keychain that raises a password
    // prompt. D16.12.1 removed it: the data-protection keychain is the only path,
    // and a build that cannot use it fails instead of quietly storing the
    // identity somewhere weaker.
    const start = src.indexOf('private static func baseQuery(_ key: String)');
    expect(start).toBeGreaterThan(-1);
    const single = src.slice(start, src.indexOf('\n  }', start));
    expect(single).toMatch(/kSecUseDataProtectionKeychain as String: true/);
    // SHAPE, not spelling. Negatives keyed on the old identifier are useless: a
    // reviewer reconstructed the exact pre-fix downgrade under a neutral name
    // (if dpKeychainAvailable { query[...] = true }) and all four of these
    // assertions still passed. What cannot be faked is the FORM: the flag is a
    // literal entry in a dictionary that is returned directly, with no local, no
    // branch, and no mutation of it anywhere in the body.
    // Comments stripped first: the prose above the entry explains the removed
    // branch and contains the word "if", and a source-text test that can be
    // satisfied or broken by a COMMENT is the trap this file keeps hitting.
    const code = single.replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bvar\b/);
    expect(code).not.toMatch(/\bif\b|\bguard\b|\?\s*:/);
    // Positive control: the stripped slice is not empty, so the negatives above
    // are not passing on a slice that failed to capture.
    expect(code.trim().length).toBeGreaterThan(0);
  });

  it('the data-protection keychain cannot be re-derived away from baseQuery', () => {
    // baseQuery is asserted above to CONTAIN both flags. Containment is not the
    // decision, though: what the decision rules out is any SECOND place a
    // SecItem query is assembled. A reviewer kept baseQuery perfect and added a
    // get()-local `query[kSecUseAuthenticationUI as String] =
    // kSecUseAuthenticationUIAllow`, or a `query.removeValue(forKey:
    // kSecUseAuthenticationUI as String)`, and every assertion in this file
    // still passed -- a set()-local strip is worse still, because it removes the
    // flag from exactly the write path the SecItemUpdate hang needs it on.
    //
    // So these are COUNTS over the whole comment-stripped file, not substrings:
    // exactly one occurrence means the value cannot be set, or unset, anywhere
    // else, because a second assignment is now visible as a second occurrence.
    // Zero occurrences of the removal call is the blunt half of the same idea --
    // this store has no reason to mutate a query dict at all, and requiring the
    // absence of the mechanism is what survives the next rewrite of HOW the
    // flags are assembled.
    const code = stripSwiftComments(
      readFileSync(join(MACOS, 'Daak-macOS', 'KeychainSecureStore.swift'), 'utf8'),
    );

    // Exactly ONE, and it is baseQuery's literal entry. M-a's `...UIAllow`
    // overwrite is a second occurrence whatever its value, so the count is the
    // assertion and the spelling is just there to say which entry must be it.
    expect(code.match(/kSecUseAuthenticationUI as String/g)).toHaveLength(1);
    // M-b's removeValue takes the count to zero and does not reintroduce the
    // token, so the count alone would miss it: hence the zero-occurrence rule
    // below, which is the real guard here.
    expect(code).not.toContain('removeValue');

    // Same shape for the data-protection keychain, and the reason it has to be
    // ONE: M-c copies baseQuery into a local and strips kSecUseDataProtection
    // there, so the value still appears once -- in baseQuery -- while the write
    // lands in the legacy file keychain again. `kSecUseDataProtection` alone is
    // already forbidden by the test above; this is what forbids the STRIP that
    // reintroduces it, which the substring cannot see.
    expect(code.match(/kSecUseDataProtectionKeychain as String/g)).toHaveLength(1);
    // Positive control on the slice itself: a count of zero or one is also what
    // a mis-parsed file produces, so the anchors must actually be locatable.
    const bqAt = code.indexOf('private static func baseQuery(_ key: String)');
    expect(bqAt).toBeGreaterThan(-1);
    const baseQuery = code.slice(bqAt, code.indexOf('\n  }', bqAt));
    expect(baseQuery).toContain('kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail');
    expect(baseQuery).toContain('kSecUseDataProtectionKeychain as String: true');

    // KNOWN CEILING, deliberately not asserted around. These flag checks are
    // OCCURRENCE COUNTS over text, so `private typealias UIKey =
    // kSecUseAuthenticationUI` followed by `query[UIKey as String] =
    // kSecUseAuthenticationUIFail` keeps the count at one and every assertion
    // above passes, while the same key is still settable from a second place.
    // The guard against an indirection like that is CODE REVIEW, not a fifth
    // assertion: no amount of text matching distinguishes kSecUseAuthenticationUI
    // from a name that means exactly the same thing, so chasing it is an
    // unbounded loop with a false payoff. Same for a renamed or re-derived
    // constant. Recorded here so the next reader knows the counts are a floor on
    // the coverage, not a ceiling on the risk.
  });

  it('only "no such key" returns nil; every other keystore status throws', () => {
    // R40(c), and the single defect this whole change exists to prevent. nil
    // means "first launch, nothing to restore". The Rust side reads nil from
    // import_from_store as (None, None) and MINTS A FRESH Ed25519 identity -- so
    // any keystore FAILURE reported as nil is not a store detail, it is a silent
    // re-pair of a device the user already paired, with no error anywhere.
    //
    // errSecInteractionNotAllowed is the exact status that flattening would
    // launder, because it is what kSecUseAuthenticationUIFail PROVOKES on
    // purpose: the dialog is converted into a refusal precisely so this switch
    // can throw instead of hanging. Handling it as 'also absent' undoes the
    // conversion and reintroduces the re-pair, one layer up from where the
    // flag was set -- and the flag would still be present for every test that
    // only checks it exists.
    const code = stripSwiftComments(
      readFileSync(join(MACOS, 'Daak-macOS', 'KeychainSecureStore.swift'), 'utf8'),
    );
    // ONE nil return in the whole file. `return nil` is the only statement a
    // keystore failure can take to become a minted identity, so pinning its count
    // pins the hole itself rather than one spelling of it.
    expect(code.match(/return nil/g)).toHaveLength(1);
    const nilAt = code.indexOf('return nil');
    // Its ARM, not its neighbourhood. M-d adds errSecInteractionNotAllowed to the
    // existing case, so the two sit on ONE line here and the same-line check
    // catches it without any block-brace guessing. A split across two lines
    // (`case errSecItemNotFound,\n  errSecInteractionNotAllowed:`) would slip
    // past it, so the arm is also re-joined and searched.
    const caseLine = lineAt(code, 'return nil').trim();
    expect(caseLine).toBe('return nil');
    // The line above it, which is the case LABEL. Slicing to the next ':'
    // forward from the return would run past the `default:` and swallow the
    // whole tail of the switch; the label is the previous physical line, and
    // joining it here is what makes the same-line claim survive a multi-line
    // `case a,\n b:` split.
    const armEol = code.lastIndexOf('\n', nilAt);
    const arm = code
      .slice(code.lastIndexOf('\n', armEol - 1) + 1, armEol)
      .replace(/^\s*case\s+/, '')
      .replace(/\s*:\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .split(/\s*,\s*/)
      .sort()
      .join(', ');
    expect(arm).toBe('errSecItemNotFound');
    expect(arm).not.toContain('errSecInteractionNotAllowed');
    // The throw is not gone either: it is what the arm's `default` does, and
    // without it 'the one nil' above would be satisfied by a switch whose every
    // other arm falls out of the function and returns nil implicitly.
    const getAt = code.indexOf('func get(key: String) throws -> String?');
    expect(getAt).toBeGreaterThan(-1);
    const get = code.slice(getAt, code.indexOf('func set(key: String, value: String)', getAt));
    expect(get).toMatch(/default:\s*\n\s*throw FfiStoreError\.Store\(/);
    expect([...get.matchAll(/return[^\n;]*/g)].map((m) => m[0].trim())).toEqual([
      'return value',
      'return nil',
    ]);

    // C-1: `fallthrough` is the one way a second case label reaches that same
    // `return nil` from OUTSIDE the one physical line the arm extraction above
    // reads. It is the sibling of the multi-line `case a, b:` split this test
    // already covers -- same nil return, same errSecInteractionNotAllowed
    // laundering, from a label the line-offset assertion structurally cannot
    // see. Flattening that status to nil is the exact harm the whole change
    // exists to prevent: the Rust side reads nil from import_from_store as
    // (None, None) and MINTS A FRESH Ed25519 identity, silently re-pairing a
    // device the user already paired. So the arm count is asserted structurally
    // -- over the brace-balanced switch, how many `case` labels can reach the
    // nil -- and not with another line offset, which is what left the hole.
    const switchAt = code.indexOf('switch status', getAt);
    expect(switchAt).toBeGreaterThan(-1);
    const sw = code.slice(switchAt, blockEndAt(code, switchAt) + 1);
    // The window is the nil arm and NOTHING before it: from the LAST case label
    // that precedes the nil, forward to the nil itself. errSecSuccess is an arm
    // in this switch and it returns `value`, not nil, so it must not be counted
    // -- but it does sit inside a naive slice-to-nil window, which would make
    // this assertion unsatisfiable against the real source.
    const nilInSwitch = sw.indexOf('return nil');
    const nilArm = sw.slice(sw.lastIndexOf('case ', nilInSwitch), nilInSwitch);
    expect([...nilArm.matchAll(/case\s+errSec\w+/g)].map((m) => m[0].replace(/\s+/g, ' ')))
      .toEqual(['case errSecItemNotFound']);
    // THE PART THAT DOES THE WORK. The window above starts at the LAST label
    // before the nil, so it is happy with a fallthrough sitting ABOVE that
    // label -- which is exactly N1, and which a naive slice-to-nil window would
    // not see either (errSecSuccess's `guard ... else {` closes deeper than its
    // own arm, so a flat indexOf('}') truncates the switch before the nil).
    //
    // So: collect every `case errSec...` label whose statements contain no
    // `return`, `break`, `throw` or `fallthrough` on the way down to the nil.
    // Nothing else can leave a Swift arm, so a label in that set can only reach
    // the nil by falling through -- which makes this a claim about REACHABILITY
    // rather than about the last label in the file. It holds for `case a, b:` on
    // one line, on two, and for a label two lines up, because all three put a
    // second status into the set.
    const nilStatuses = new Set<string>();
    let label = lastLabelBefore(code, nilAt);
    expect(label).toBeGreaterThan(-1);
    while (label > -1) {
      nilStatuses.add(code.slice(label, code.indexOf(':', label)));
      label = lastLabelBefore(code, label);
    }
    expect([...nilStatuses].map((s) => s.replace(/\s+/g, ' '))).toEqual([
      'case errSecItemNotFound',
    ]);
    // And the keyword itself, zero times, over the whole comment-stripped file.
    // `return nil` is the ONLY statement a keystore failure can take to become
    // a minted identity, so pinning its count (above) pins the hole; this pins
    // the one construct in Swift that routes a different status into an arm that
    // returns nil. There is no reason for this store to fall through at all.
    //
    // Deliberately REDUNDANT with the reachability walk above, and kept for the
    // case the walk cannot cover: the walk reasons about `case errSec...` labels
    // and the exits it knows, so a fallthrough spelled any other way -- or a
    // second status folded into the nil arm under a name the walk does not match
    // -- is invisible to it and this is not. Two cheap mechanisms for one hole
    // is the right trade here: this is the defect that silently re-pairs a
    // device, and the cost of the redundancy is two lines.
    //
    // VERIFIED as load-bearing, not assumed: with THIS line removed, the N1
    // mutant (errSecInteractionNotAllowed + fallthrough above the nil arm) still
    // fails the reachability set, and with the walk removed this line is what
    // catches it. Neither check passes on its own for that mutant.
    expect(code).not.toContain('fallthrough');
  });

  it('set and delete CHECK their statuses; an unwritten key is never reported stored', () => {
    // C-2, and the real gap: the spec cited 'io: keychain write failed for
    // identity.ed25519.signing: -34018' as its load-bearing rejection, and that
    // rejection is produced by EXACTLY the two discarded arms this test now
    // covers. Both of set()'s results are checked; delete() tolerates two
    // statuses and throws on the rest. Removing either throw keeps every other
    // assertion in this file green -- the get()-only tests do not read set() or
    // delete() at all -- and turns R40(c) from 'reject on keystore failure' into
    // 'report success for an identity that was never persisted'. The engine then
    // believes it stored its signing key, every later start finds nothing, and
    // the device pairs as NEW with no error anywhere.
    const code = stripSwiftComments(
      readFileSync(join(MACOS, 'Daak-macOS', 'KeychainSecureStore.swift'), 'utf8'),
    );

    // -- SecItemUpdate, the UPDATE path ---------------------------------------
    const setAt = code.indexOf('func set(key: String, value: String)');
    expect(setAt).toBeGreaterThan(-1);
    const set = code.slice(setAt, blockEndAt(code, setAt) + 1);
    // The result is captured into a named local and COMPARED, not discarded.
    // The capture is what makes the comparison reachable; a `let _ =
    // SecItemUpdate(...)` or a bare `SecItemUpdate(...)` discards it and is
    // caught here. `status` is the store's own name for it (the update and the
    // add have different names, so they cannot alias one another).
    expect(set).toMatch(/let status = SecItemUpdate\(/);
    expect(set).toMatch(/if status == errSecSuccess/);
    // The guard is a MULTI-LINE guard: `guard ... else { throw }`. A guard whose
    // else block does not throw makes the throw below unreachable and this fails.
    expect(set).toMatch(/guard status == errSecItemNotFound else \{\s*throw FfiStoreError\.Store\(/);
    // -- SecItemAdd, the CREATE path -----------------------------------------
    const addAt = set.indexOf('let addStatus = SecItemAdd(');
    expect(addAt).toBeGreaterThan(-1);
    expect(set).toMatch(/let addStatus = SecItemAdd\(/);
    // AND it is compared, not merely captured. This is the -34018 arm exactly:
    // SecItemAdd is the call that returns errSecMissingEntitlement on an
    // ad-hoc-signed build, and `if addStatus != errSecSuccess { NSLog(...) }`
    // -- capture without compare -- would keep this assertion satisfied while
    // discarding the one status that decides the whole start.
    expect(set).toMatch(/guard addStatus == errSecSuccess else \{\s*throw FfiStoreError\.Store\(/);

    // -- delete(), best-effort on exactly two statuses ------------------------
    // Not-found IS the ordinary answer for a key that was never written and is
    // deliberately tolerated; every OTHER status throws. `guard A || B else
    // { throw }` is the only form that both tolerates the two and throws on the
    // rest, and asserting the pair (tolerated set, throw) together is what
    // stops `delete()` from swallowing every status it is handed.
    const delAt = code.indexOf('func delete(key: String) throws');
    expect(delAt).toBeGreaterThan(-1);
    const del = code.slice(delAt, blockEndAt(code, delAt) + 1);
    expect(del).toMatch(/let status = SecItemDelete\(/);
    expect(del).toMatch(/guard status == errSecSuccess \|\| status == errSecItemNotFound else \{\s*throw FfiStoreError\.Store\(/);
  });

  it('stores the identity where a backup cannot carry it to another device', () => {
    // kSecAttrAccessible on the ADD only. The identity key is the one secret
    // here that must never be restored onto a different machine: two Macs
    // holding the same key present the same device id to every peer, which is
    // the failure a keychain at all is supposed to make impossible.
    //
    // Not a toContain. M-e swaps the class for kSecAttrAccessibleAlways --
    // deprecated, and readable while the device is off -- and M-f deletes the
    // line outright. Both leave every other flag assertion in this file intact,
    // because neither touches baseQuery and both produce valid Swift. The pair
    // of assertions is what covers them: a count of exactly one rejects the
    // deleted line (zero), and the exact text of that one line rejects the
    // swapped class AND any second, differently-accessible write path.
    const code = stripSwiftComments(
      readFileSync(join(MACOS, 'Daak-macOS', 'KeychainSecureStore.swift'), 'utf8'),
    );
    expect(code.match(/kSecAttrAccessible as String/g)).toHaveLength(1);
    // The whole line, so a trailing `as kSecAttrAccessibleAlwaysThisDeviceOnly`
    // appended to a correct line cannot ride in on the same occurrence.
    expect(
      code
        .split('\n')
        .filter((l) => l.includes('kSecAttrAccessible as String'))
        .map((l) => l.trim()),
    ).toEqual([
      'add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly',
    ]);
    // Named anywhere in the stripped file at all: AfterFirstUnlockThisDeviceOnly
    // is the one class that is BOTH unlocked-by-background-loop (a
    // WhenUnlocked class would put a passcode prompt in front of every accept)
    // and never migrates (ThisDeviceOnly is the half that does not restore).
    // Asserted over the file rather than derived from the line above so a
    // mutant cannot satisfy both by naming the class somewhere inert.
    expect(code).toContain('kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly');
    expect(code).not.toMatch(/kSecAttrAccessibleAlways\b/);
  });

  it('macOS has no file-store fallback when the keychain is unusable', () => {
    // Measured on this host, 2026-10-01. With an ad-hoc-signed build carrying
    // the sandbox entitlement, SecItemAdd for the identity key fails with
    //
    //   -34018  errSecMissingEntitlement
    //
    // and the engine then refuses to start:
    //
    //   daak: engine start failed: [Error: Engine(message: "io: keychain write
    //   failed for identity.ed25519.signing: -34018")]
    //
    // So this is NOT a cosmetic warning. -34018 is specifically what an
    // ad-hoc (identitiless) signature gets back for a keychain operation, which
    // is why it reproduces here and not in the iOS simulator, where the
    // simulator signs as a real identity.
    //
    // A DEVELOPMENT or Developer ID certificate fixes it properly -- the
    // entitlement is then granted -- but this host has zero code-signing
    // identities (`security find-identity -v -p codesigning` -> "0 valid
    // identities found"), so there is nothing to fix it with here. Signing the
    // build ad-hoc on purpose was measured and REJECTED: it builds and launches,
    // but re-signing an app to add keychain-access-groups produces a binary the
    // kernel refuses to spawn (Launchd job spawn failed, errno 153).
    //
    // The shipped answer is NO FALLBACK. `DaakEngine(sink:)` selects the UDL's
    // plain constructor, whose start() uses the 0600 PersistentFileStore
    // (crates/daak-ffi/src/lib.rs:401), so reaching for it is reaching for a
    // different identity store. R40(c) requires the start to REJECT, and the
    // existing mobile test says so in as many words: a keystore failure must
    // reject; falling back to the file store would mint a new identity and
    // re-pair the device silently.
    //
    // The concrete cost of the shape that shipped in b122254: a SIGNED build has
    // a keychain identity, then an ad-hoc build mints a FILE identity under the
    // same service name, and from then on the active identity flips with the
    // build signature. Both stores coexist and neither is ever removed.
    const swift = readFileSync(join(MACOS, 'Daak-macOS', 'Daak.swift'), 'utf8');
    expect(swift).not.toContain('DaakEngine(sink:');
    // Whitespace-tolerant, because the substring above is not. A reviewer
    // reintroduced the file-store fallback with `DaakEngine(` and `sink: self)`
    // on separate lines and the suite stayed green -- one newline from silently
    // restoring exactly the downgrade this ruling removed. The positive
    // assertion below does not catch it either: newWithStore is still present
    // beside the fallback.
    expect(swift).not.toMatch(/DaakEngine\s*\(\s*\n?\s*sink:/);
    // And always the keychain one: newWithStore, unconditionally.
    expect(swift).toMatch(/DaakEngine\.newWithStore\(store: KeychainSecureStore\(\), sink: self\)/);
    // No probe and no branch left behind. probeKeychain wrote a synthetic item
    // and SecItemUpdate'd the REAL identity keys, which is a write to the user's
    // keychain at module scope -- side effects a constructor must not have.
    expect(swift).not.toMatch(/keychainUsable|probeKeychain/);
    const store = readFileSync(join(MACOS, 'Daak-macOS', 'KeychainSecureStore.swift'), 'utf8');
    expect(store).not.toMatch(/func probeKeychain|keychainUsable|useDataProtection/);
  });

  it('there is a macOS engine build script, like the ios and android ones', () => {
    // macOS had NO Rust engine build path at all: Phase 6 assumed desktop got
    // its engine from daakd over IPC. gen-macos-ffi.sh is what makes the native
    // half of the in-process ruling buildable rather than aspirational.
    const script = join(APP, '..', '..', 'apps', 'mobile', 'scripts', 'gen-macos-ffi.sh');
    expect(existsSync(script)).toBe(true);
    const src = readFileSync(script, 'utf8');
    expect(src).toContain('aarch64-apple-darwin');
    expect(src).toContain('x86_64-apple-darwin');

    // The uniffi bindgen version has to equal what daak-ffi compiled against or
    // the generated Swift method names Daak.swift calls do not exist. The pin is
    // read from the TRACKED manifest, never from Cargo.lock: the lockfile is
    // untracked and forbidden from staging, so on a clean checkout it is not
    // there at all and the old awk read it as EMPTY, emitting
    // `uniffi = { version = "=" }` -- unresolvable. Worse, on a machine where it
    // does exist the pin comes back as whatever that machine happened to
    // resolve (=0.28.3) instead of the manifest's 0.28, so the same commit builds
    // different bindings per machine. A file that is deliberately not version
    // controlled cannot be a source of truth for a version-controlled build.
    const REPO = join(APP, '..', '..');
    expect(src).toContain('crates/daak-ffi/Cargo.toml');
    // NOTHING in the executable body reads the lockfile. Stripped of comments
    // first, because this script's comment explains the Cargo.lock mistake at
    // length and names it twice -- the raw text therefore says 'Cargo.lock'
    // whether or not any command ever mentions it.
    const body = src
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(body).not.toContain('Cargo.lock');
    // The empty-extraction guard: if the manifest moves, is reformatted or is
    // read on a machine where sed's bracket class behaves differently, an
    // EMPTY pin has to hard-fail the build rather than ship `version = "="`.
    expect(body).toMatch(/test -n "\$version"/);
    // ...and the guard has to be FATAL. A `test -n "$version"` with the
    // `exit 1` removed still satisfies the assertion above, still names the same
    // message, and lets an empty pin sail on into
    // `uniffi = { version = "=" }` -- the exact unresolvable dependency the
    // guard exists to stop. Asserted as `exit` WITHIN the guard's own line, so a
    // detached `exit 1` later in the script cannot stand in for it.
    const guardLine = body.split('\n').find((l) => l.includes('test -n "$version"'));
    expect(guardLine).toMatch(/exit 1/);

    // M-3, part one: EXACTLY ONE `version=` assignment in the whole script body.
    // The behavioural run below takes the FIRST such line, so a second one --
    //
    //   version="$(awk '/^name = "uniffi_bindgen"$/{...}' Cargo.lock)"
    //
    // -- silently wins that run while the value the BUILD actually uses still
    // comes from the manifest: the test goes green asserting the lockfile's
    // 0.28.3 while a manifest drift to 0.29 ships bindings compiled against a
    // different uniffi, and the missing Swift method names surface only as a
    // compile error inside an Xcode build phase. One assignment, so there is no
    // second value to win anything.
    const versionLines = body.split('\n').filter((l) => l.startsWith('version='));
    expect(versionLines).toHaveLength(1);

    // Behaviour, not spelling: RUN the script's own extraction line against the
    // real tracked manifest and assert the pin is the one it declares. This is
    // stronger than every assertion above it, because it cannot be satisfied by
    // the right words in the wrong command -- point the line at the lockfile, at
    // the wrong crate, or at a pattern that matches nothing and it answers
    // something else. The guard above only proves a check exists, not that what
    // it checked was the right thing.
    // The LAST assignment, and the point of the length check above is what makes
    // it safe to say so: with exactly one assignment, first and last are the
    // same line, so the run cannot be aimed at a decoy -- but if a second is ever
    // added the count fails loudly HERE rather than the run silently executing
    // the wrong one. That is the whole difference between this test and the
    // revision that read the lockfile and reported 0.28 while the build used the
    // manifest.
    const readLine = body.split('\n').find((l) => l.startsWith('version_lines="'));
    const versionLine = versionLines.at(-1);
    expect(readLine).toBeDefined();
    expect(versionLine).toBeDefined();
    expect(
      // bash, not /bin/sh: the cut line is ANSI-C quoted (`$'\n'`), which dash
      // does not support. The point is to execute the extracted lines verbatim,
      // quoting and all.
      execFileSync('bash', ['-c', `${readLine}\n${versionLine}\nprintf %s "$version"`], {
        cwd: REPO,
        encoding: 'utf8',
      }),
    ).toBe('0.28');

    // And the first-line cut is load-bearing, which the real-manifest run cannot
    // show: the real file's two `uniffi` lines carry DIFFERENT trailing feature
    // lists, so a dropped cut yields the right string anyway. Same shape,
    // identical features on both lines -- which is what makes the requirement
    // unresolvable (version="0.28\n0.28") rather than merely untidy -- so a
    // dropped cut is caught.
    const TOML = [
      '[package]',
      'name = "daak-ffi"',
      '',
      '[dependencies]',
      'uniffi = { version = "0.28", features = ["cli"] }',
      '',
      '[build-dependencies]',
      'uniffi = { version = "0.28", features = ["cli"] }',
      '',
    ].join('\n');
    // The sed half of the script's own read line, reused verbatim: the fixture
    // test exists to prove the cut is load-bearing for THIS pattern, so a
    // pattern written out here instead would be testing a different command.
    const sed = readLine!.match(/sed -n '[^']*'/)?.[0];
    expect(sed).toBeDefined();
    const raw = execFileSync('/bin/sh', ['-c', `${sed} <<'TOML'\n${TOML}TOML`], {
      encoding: 'utf8',
    });
    expect(raw).toBe('0.28\n0.28\n');
    // Apply the script's own cut line to the two-line value. The `$'...'` is
    // ANSI-C quoted, so this run needs bash, not dash.
    expect(
      execFileSync('bash', ['-c', `version_lines=$'0.28\\n0.28'\n${versionLine}\nprintf %s "$version"`], {
        encoding: 'utf8',
      }),
    ).toBe('0.28');
  });

  it('the xcode project links the generated staticlib and the ffi module', () => {
    // A staticlib in a directory the project does not reference is a build that
    // succeeds and links Daak.swift against nothing.
    const pbx = readFileSync(join(MACOS, 'Daak.xcodeproj', 'project.pbxproj'), 'utf8');
    expect(pbx).toContain('libdaak_ffi.a');
  });

  it('tells the Swift compiler where the ffi clang modulemap is', () => {
    // This one cost a full from-scratch Pods build to find, and it fails in the
    // most misleading way possible. HEADER_SEARCH_PATHS is NOT enough for
    // `import daak_ffiFFI`: Swift needs the modulemap handed to it explicitly,
    // as -Xcc -fmodule-map-file=... in OTHER_SWIFT_FLAGS, which is exactly what
    // apps/mobile/ios/Daak.xcodeproj:651 does. Without it the build gets all the
    // way to EmitSwiftModule and then reports, on the Daak class declaration
    // itself:
    //
    //   error: cannot find type 'DaakEngine' in scope
    //   error: cannot find type 'EventSink' in scope
    //
    // i.e. it looks like the generated Swift bindings are missing or wrong.
    // They are fine; the compiler was never told the module exists.
    const pbx = readFileSync(join(MACOS, 'Daak.xcodeproj', 'project.pbxproj'), 'utf8');
    // Two occurrences: Debug and Release. One is satisfied by either.
    expect(pbx.match(/OTHER_SWIFT_FLAGS = .*fmodule-map-file=/g)).toHaveLength(2);
  });

  it('compiles the generated Swift bindings as a source file', () => {
    // Daak.swift conforms to EventSink and holds a DaakEngine, both of which are
    // declared in the GENERATED daak_ffi.swift. That file has to be in the
    // target's compile sources, not merely on disk -- iOS adds it by path
    // (Daak.xcodeproj:479). Swift has no implicit "find it next to me" here.
    const pbx = readFileSync(join(MACOS, 'Daak.xcodeproj', 'project.pbxproj'), 'utf8');
    expect(pbx).toContain('build/generated/ffi/daak_ffi.swift');
  });

  it('the app sandbox lets the engine both accept and reach peers', () => {
    // Measured on this host, 2026-10-01: with only network.client the engine
    // got as far as keychain init and then died on
    //
    //   daak: engine start failed: Engine(message: "io: Operation not permitted
    //   (os error 1)")
    //
    // and the app process owned no listening socket. Engine startup BINDS a TCP
    // listener before it advertises anything, and the sandbox returns EPERM for
    // a bind with no network.server entitlement. It is not the UI, and not the
    // FFI: a dashboard with a dead engine looks perfect, which is the failure
    // mode this file exists to catch.
    //
    // client-only is the shape Phase 6 shipped, and it cannot work in-process:
    // for a daemon/IPC desktop the app talks OUT and daakd binds, so client was
    // the whole of it.
    const entitlements = readFileSync(
      join(MACOS, 'Daak-macOS', 'Daak.entitlements'),
      'utf8',
    );
    expect(entitlements).toContain('com.apple.security.network.client');
    expect(entitlements).toContain('com.apple.security.network.server');
  });

  it('never blocks the engine on a keychain dialog', () => {
    // Measured on this host, 2026-10-01, and this one is a HANG, not an error.
    // After network.server was added the app launched clean -- no
    // "engine start failed" in Metro's log, no listener, no mDNS socket -- which
    // reads like "still working on it". It was not. `sample 8901` had 2262 of
    // 2262 samples on one stack:
    //
    //   DaakEngine.start -> import_from_store -> FfiSecretStore::get
    //     -> KeychainSecureStore.get -> SecItemCopyMatching
    //     -> SecKeychainItemCopyContent -> CSSM_DecryptDataFinal
    //     -> SecurityServer::ClientSession::decrypt -> mach_msg
    //
    // i.e. blocked on a mach message to securityd, waiting for a UI answer that
    // never comes, BEFORE tcp::bind ever runs. Nothing rejects, so
    // engine.start() never settles: no listener, no port, no log line, forever.
    // Absence-of-error is exactly the signal that was misleading here.
    //
    // Why the dialog at all: this host has 0 signing identities, so the build is
    // ad-hoc, and a legacy-keychain item's ACL is keyed on the CODE SIGNATURE
    // that wrote it. Every rebuild is a different ad-hoc signature, so the
    // item written by the previous build (16:35:36Z, confirmed with
    // `security find-generic-password`) no longer matches and securityd asks
    // the user to unlock instead. That is the recurring password popup, and it
    // is why the engine cannot start on this host at all until the store stops
    // being allowed to prompt.
    //
    // kSecUseAuthenticationUIFail is HALF the fix: on the read query it turns
    // the dialog into errSecInteractionNotAllowed rather than showing UI, and
    // the store turns that into FfiStoreError so R40(c) rejects the start. But
    // it does NOT cover SecItemUpdate -- measured, the probe's own
    // SecItemUpdate against the pre-existing item blocked in exactly the same
    // CSSM_DecryptDataFinal -> mach_msg stack with the flag set. So the flag
    // alone leaves the hang in place for the write path, and the engine still
    // never starts.
    //
    // The rest of the fix is SecKeychainSetUserInteractionAllowed(false) on the
    // ENGINE QUEUE, which is the only scope that covers every Security call at
    // once. It is per-THREAD state, so it is set on the queue Daak.start runs
    // on, and it is why the test pins the queue by name: setting it anywhere
    // else, or setting it once globally, leaves the hang exactly where it was.
    const swift = readFileSync(join(MACOS, 'Daak-macOS', 'Daak.swift'), 'utf8');
    expect(swift).toContain('SecKeychainSetUserInteractionAllowed');
    // And it must be scoped to the engine queue, not applied once at startup:
    // it is per-thread state, and SecItem calls run on that queue's thread.
    expect(swift).toMatch(/dev\.darshit\.daak\.engine[\s\S]*SecKeychainSetUserInteractionAllowed/);

    const store = readFileSync(
      join(MACOS, 'Daak-macOS', 'KeychainSecureStore.swift'),
      'utf8',
    );
    expect(store).toContain('kSecUseAuthenticationUIFail');
    // Every SecItem query is built in ONE place (baseQuery), so putting it here
    // covers get, set and delete together rather than per call site.
    //
    // The dictionary ENTRY, not the token. This slice runs to end-of-file and
    // the comment two lines above the real entry begins "kSecUseAuthentication
    // UIFail turns that dialog into" -- so a toContain on the bare token passed
    // with the real entry deleted. That flag is the entire non-hang guarantee
    // for the read path, and it was therefore unverified.
    const baseQuery = store.slice(store.indexOf('private static func baseQuery(_ key: String)'));
    expect(baseQuery).toContain('kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail');
    // AND baseQuery is the ONLY place a query is built. A reviewer hand-rolled a
    // second SecItemUpdate query dictionary with neither flag and the suite
    // stayed green, because the two assertions above only prove the flags exist
    // SOMEWHERE. The premise they rest on -- "every SecItem query is built in ONE
    // place" -- was asserted nowhere, and the call site they would have added is
    // exactly the SecItemUpdate that hangs in mach_msg. kSecAttrService appears
    // once in the file precisely because it lives only inside baseQuery; a
    // hand-rolled query must carry its own service key to work at all.
    expect(store.match(/kSecAttrService as String:/g)).toHaveLength(1);
    // Same premise for the deletes: two SecItemDelete sites is the same hole.
    expect(store.match(/SecItemDelete\(/g)).toHaveLength(1);
    // And no call site may construct a query literal of its own.
    expect(store).not.toMatch(/kSecClass: kSecClassGenericPassword/);
  });

  it('restores keychain interaction after the start it suppressed it for', () => {
    // SecKeychainSetUserInteractionAllowed is PROCESS-WIDE global state, not a
    // per-object setting, and b122254 set it to false with no restore. The app
    // therefore ran, for the rest of its life, with Security allowed to never
    // prompt ANYONE for anything -- including the Share Extension's own keychain
    // reads and any Mac App Store prompt the OS may need. That is a far wider
    // blast radius than the one engine start it was meant to cover.
    //
    // Suppress -> start -> restore, all inside ONE q.async block: the flag is
    // per-THREAD state and the SecItem calls run on that queue's thread, so
    // splitting it across submissions would restore it before the reads happen.
    // (Which is also why the suppression cannot simply be dropped: without it
    // the read blocks in mach_msg forever -- see the test above.)
    const swift = readFileSync(join(MACOS, 'Daak-macOS', 'Daak.swift'), 'utf8');
    const off = swift.indexOf('SecKeychainSetUserInteractionAllowed(false)');
    const on = swift.indexOf('SecKeychainSetUserInteractionAllowed(true)');
    const start = swift.indexOf('try e.start(');
    expect(off).toBeGreaterThan(-1);
    expect(on).toBeGreaterThan(off);
    expect(start).toBeGreaterThan(on);
    // Inside a defer, so it runs on the reject path too: an early return between
    // the two must not leave the process permanently non-interactive.
    const before = swift.slice(0, on);
    expect(before.slice(before.lastIndexOf('do {'))).toMatch(/defer\s*\{/);
    // Anchored on the block that CONTAINS the suppression, not on the last
    // `do {` textually before the restore. lastIndexOf finds the START of any
    // earlier do-block in the file, so it answers 'is there a do somewhere
    // above', not 'is the defer inside this one' -- and Daak.swift has three
    // q.async blocks (start, shutdown, run), so it could only ever return the
    // start one. What has to be true is that the restore and the defer are both
    // inside the ENCLOSING block's own brace range: the flag is per-THREAD state
    // and these SecItem calls run on this queue's thread, so a defer moved to a
    // sibling block is not a smaller version of the bug, it is the same bug.
    // Brace-balanced rather than indexOf('}'), because the enclosing block is
    // `q.async { do { ... } }` -- a flat search stops on the do-block's close and
    // would report the defer as outside its own block.
    const code = stripSwiftComments(swift);
    const blockAt = code.lastIndexOf('q.async {', off);
    expect(blockAt).toBeGreaterThan(-1);
    const block = code.slice(blockAt, blockEndAt(code, blockAt) + 1);
    expect(block).toContain('SecKeychainSetUserInteractionAllowed(false)');
    expect(block).toContain('SecKeychainSetUserInteractionAllowed(true)');
    // Searched over the whole stripped file, not code.slice(off): the word
    // `defer` appears in Daak.swift's COMMENTS (stripped here, but not in a
    // slicing bug's world), and pinning the index lets the range assertions
    // below read as 'inside this block' rather than 'inside a slice of the file
    // that starts here'.
    const deferAt = code.indexOf('defer');
    expect(deferAt).toBeGreaterThan(-1);
    // Inside the q.async block's own range, not merely somewhere after it.
    expect(deferAt - blockAt).toBeGreaterThan(0);
    expect(deferAt).toBeLessThan(blockAt + block.length);
    // And inside the do-block, which is where the early returns are: a defer on
    // the q.async body but outside the do would still not run for a throw.
    const doAt = block.indexOf('do {');
    expect(doAt).toBeLessThan(deferAt - blockAt);
    expect(block.slice(doAt + 4, block.lastIndexOf('}'))).toMatch(/defer\s*\{/);
    // Status-checked both ways. An unchecked set is how a build that cannot
    // suppress at all gets a HANG instead of an error.
    expect(swift).toMatch(/guard\s+SecKeychainSetUserInteractionAllowed\(false\)\s*==\s*errSecSuccess/);

    // M-2: the restore must be UNCONDITIONAL. A defer whose restore sits behind
    // a ternary --
    //
    //   let status = kSecUseAuthenticationUIAllow == 0 ? errSecSuccess
    //     : SecKeychainSetUserInteractionAllowed(true)
    //
    // -- satisfies every assertion above, because the call text is still in the
    // defer. And it is DEAD: kSecUseAuthenticationUIAllow is 0 in Security, so
    // the branch never runs and the process stays globally non-interactive for
    // its whole life -- verbatim the b122254 defect the defer was added to fix,
    // restored by a one-line change that reads like a refactor. So: no ternary,
    // no `if` in the defer body, with the call unconditional.
    //
    // Scoped by brace balance from the `defer {` this test already locates, so
    // it is the RESTORE's body being asserted and not a window of the file: an
    // `if` in the enclosing do-block (there are several) cannot fail it, and one
    // inside the defer cannot hide behind them.
    const deferInBlock = deferAt - blockAt;
    const deferBody = block.slice(deferInBlock, blockEndAt(block, deferInBlock) + 1);
    expect(deferBody).toContain('SecKeychainSetUserInteractionAllowed(true)');
    expect(deferBody).not.toMatch(/\?\s*:/);
    // And nothing between the defer's opening brace and the call that could skip
    // it: the call is the WHOLE right-hand side of the defer's first statement,
    // so the ternary above cannot exist without pushing it off line one and
    // failing here too. Only the local's NAME is left free.
    //
    // The `if` AFTER the call is deliberately NOT forbidden. This defer does
    // check its restore status and NSLog when it fails, which is worth having --
    // so `no if anywhere in the defer` would be an assertion the real, correct
    // source cannot satisfy. What has to be unconditional is the CALL, and that
    // is what first-statement-plus-no-ternary pins.
    expect(deferBody.slice(deferBody.indexOf('{') + 1).trim()).toMatch(
      /^let\s+\w+\s*=\s*SecKeychainSetUserInteractionAllowed\(true\)/,
    );
  });

  it('xcode regenerates the macos ffi bindings as a build phase', () => {
    // Without a build phase the generated bindings are whatever happened to be on
    // disk. b122254 built green because apps/desktop/macos/build/generated/ffi
    // was already populated by a manual run of the script; a clean checkout has
    // no such directory, and the build fails at EmitSwiftModule with
    // "cannot find type 'DaakEngine' in scope" -- the exact misleading error the
    // modulemap test above documents, one level further out.
    //
    // iOS has had this since Phase 4 (Script-DA0AB0341A68108700A75B9A.sh runs
    // gen-ios-ffi.sh). macOS must invoke gen-macos-ffi.sh the same way, and from
    // the Daak-macOS target's buildPhases specifically -- putting it on the iOS
    // target or in the project would be built only by an iOS build.
    const pbx = readFileSync(join(MACOS, 'Daak.xcodeproj', 'project.pbxproj'), 'utf8');
    expect(pbx).toContain('gen-macos-ffi.sh');
    // The Daak-macOS target's OWN buildPhases list, ending at its closing brace.
    // A reviewer showed that slicing to the end of the PBXNativeTarget section
    // spans ShareExtension too, and that moving the phase to ShareExtension -- or
    // to a position AFTER Sources, which breaks the exact failure this test
    // exists for -- left the test green.
    const targetStart = pbx.indexOf('514201482437B4B30078DB4F /* Daak-macOS */ = {');
    expect(targetStart).toBeGreaterThan(-1);
    const target = pbx.slice(targetStart, pbx.indexOf('\n\t\t};', targetStart));
    const phaseId = pbx.slice(0, pbx.indexOf('gen-macos-ffi.sh')).match(/([0-9A-F]{24})/g)!.pop();
    expect(target).toContain(phaseId!);
    // Every declared input/output path must exist. Xcode treats a missing
    // inputPaths entry as a stale-skip, not an error, so a wrong relative path
    // (two levels up instead of three) builds fine forever while the phase never
    // re-runs on a .udl change. Asserted against the repo, not a literal, so the
    // test itself cannot carry the same off-by-one.
    // Scoped to THIS phase's own inputPaths/outputPaths blocks, so the check
    // cannot pass vacuously on an empty match and cannot be satisfied by an
    // unrelated phase. The trailing backslash of a shellScript line is not in
    // these blocks, so no trimming is needed.
    // The OBJECT DECLARATION, not the ID's first occurrence. `indexOf(phaseId)`
    // lands on the reference inside the target's buildPhases list, which carries
    // no inputPaths at all -- so declared came back empty and the existence check
    // below passed without having checked anything.
    const phaseStart = pbx.indexOf(`${phaseId} /* Generate daak ffi bindings */ = {`);
    expect(phaseStart).toBeGreaterThan(-1);
    const phaseEnd = pbx.indexOf('\n\t\t};', phaseStart);
    const phase = pbx.slice(phaseStart, phaseEnd);
    const inputs = phase.slice(
      phase.indexOf('inputPaths = ('),
      phase.indexOf(');', phase.indexOf('inputPaths = (')),
    );
    const declared = [...inputs.matchAll(/"\$\{SRCROOT\}\/([^\"]+)"/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    for (const rel of declared) {
      // SRCROOT is apps/desktop/macos, one level below the repo's apps/ dir.
      expect(existsSync(join(MACOS, rel))).toBe(true);
    }
    // The outputs it CLAIMS to produce are generated, so they are checked as
    // declarations only: the four things the Swift compile and the link step
    // need. Neither the modulemap nor the header exists on disk yet, and
    // dropping either from outputPaths costs a build that fails late.
    const outputs = phase.slice(
      phase.indexOf('outputPaths = ('),
      phase.indexOf(');', phase.indexOf('outputPaths = (')),
    );
    for (const rel of [
      'build/generated/ffi/daak_ffi.swift',
      'build/generated/ffi/lib/libdaak_ffi.a',
      'build/generated/ffi/Headers/module.modulemap',
      'build/generated/ffi/Headers/daak_ffiFFI.h',
    ]) {
      expect(outputs).toContain(rel);
    }
    // The .udl EXPLICITLY, not merely "some path survived". A reviewer deleted
    // the .udl input and the suite stayed green: the existence loop above is
    // satisfied by the one entry that remains, so the phase would never re-run
    // on a .udl change -- the exact regression this phase exists to prevent.
    // The outputPaths list right above is asserted by literal for the same
    // reason, and inputPaths had no such literal until now.
    expect(declared.join(' ')).toContain('crates/daak-ffi/src/daak.udl');
    // The phase must actually INVOKE the script. Deleting the shellScript line
    // outright also left the suite green, because the
    // `expect(pbx).toContain('gen-macos-ffi.sh')` earlier in this test is
    // satisfied by the inputPaths entry that NAMES it. A phase with no script
    // is a no-op that still declares the right paths.
    // The `\"` escapes are load-bearing: Xcode writes the whole command as one
    // quoted string, so matching an unescaped quote would stop at the first
    // embedded one (the ${SRCROOT} expansion) and never reach the script name.
    expect(phase).toMatch(/shellScript = "(?:[^"\\]|\\.)*gen-macos-ffi\.sh/);
    // And BEFORE Sources, which is the phase that compiles the generated
    // daak_ffi.swift. Ordering is the whole point of the phase: after Sources it
    // is a build step that arrives too late, and the failure it prevents is the
    // "cannot find type 'DaakEngine' in scope" the modulemap test documents.
    const phases = target.slice(target.indexOf('buildPhases = ('), target.indexOf(');', target.indexOf('buildPhases = (')));
    expect(phases.indexOf(phaseId!)).toBeGreaterThan(-1);
    expect(phases.indexOf(phaseId!)).toBeLessThan(phases.indexOf('514201452437B4B30078DB4F /* Sources */'));
  });

  it('links the staticlib it just generated', () => {
    // The test above asserts a FILE REFERENCE to libdaak_ffi.a exists, which a
    // build satisfies while linking against nothing -- the "builds green, links
    // Daak.swift against nothing" class its own comment warns about. A reviewer
    // stripped `-ldaak_ffi` from BOTH configurations and the suite stayed green:
    // Xcode then fails at link with undefined symbols on DaakEngine/EventSink,
    // but nothing here claimed to cover that. Two occurrences, Debug and
    // Release, because satisfying either one alone is not enough.
    const pbx = readFileSync(join(MACOS, 'Daak.xcodeproj', 'project.pbxproj'), 'utf8');
    expect(pbx.match(/"-ldaak_ffi"/g)).toHaveLength(2);
  });

  it('requests keychain-access-groups, or every SecItem call is -34018', () => {
    // D16.12.5. kSecUseDataProtectionKeychain is available only to a sandboxed
    // app that holds keychain-access-groups; WITHOUT the entitlement SecItemAdd
    // and SecItemCopyMatching both return errSecMissingEntitlement (-34018)
    // regardless of how the app is signed. A signature grants what the plist
    // REQUESTS and invents nothing, so this is not an ad-hoc-only defect: on a
    // properly Developer-ID-signed build an entitlements file without this key
    // is the same -34018, and the engine refuses to start.
    const entitlements = readFileSync(
      join(MACOS, 'Daak-macOS', 'Daak.entitlements'),
      'utf8',
    );
    // The KEY and a group, not the key alone: `keychain-access-groups` with an
    // empty array grants nothing, so a toContain on the key name would pass on a
    // grant that is present in the file and absent at runtime.
    expect(entitlements).toMatch(
      /<key>keychain-access-groups<\/key>\s*<array>\s*<string>\$\(AppIdentifierPrefix\)group\.dev\.darshit\.daak<\/string>/,
    );
  });

  it('requests the registration-free team-prefixed App Group on macOS', () => {
    // Phase 8 Task 5. The four Xcode profiles grant NO App Group, so the
    // registered 'group.dev.darshit.daak' form cannot be used on macOS. Apple
    // documents a registration-free form for macOS, '<team id>.<group name>'.
    // containerURL(forSecurityApplicationGroupIdentifier:) looks the string up
    // EXACTLY as the entitlement writes it, so the host entitlement, the
    // extension entitlement, and the extension's Swift literal must all agree
    // on the same team-prefixed value. The team is pinned elsewhere in the
    // project as DEVELOPMENT_TEAM = J6NNRLDUG4.
    const GROUP = 'J6NNRLDUG4.group.dev.darshit.daak';
    const REPO = join(APP, '..', '..');
    const host = readFileSync(join(MACOS, 'Daak-macOS', 'Daak.entitlements'), 'utf8');
    const ext = readFileSync(
      join(REPO, 'extensions', 'macos-share', 'ShareExtension.entitlements'),
      'utf8',
    );
    const swift = readFileSync(
      join(REPO, 'extensions', 'macos-share', 'ShareViewController.swift'),
      'utf8',
    );
    // The application-groups VALUE, not a bare toContain: the keychain group
    // already spells the team out, so a toContain of the team prefix would pass
    // while the application-groups value stayed in the registered form.
    const groupValue =
      /<key>com\.apple\.security\.application-groups<\/key>\s*<array>\s*<string>([^<]+)<\/string>/;
    for (const [name, src] of [
      ['Daak.entitlements', host],
      ['ShareExtension.entitlements', ext],
    ] as const) {
      const match = src.match(groupValue);
      expect(match, name + ' must request an application group').not.toBeNull();
      expect(match![1], name + ' application-groups value').toBe(GROUP);
    }
    // The literal, not a read of the entitlement at build time: the extension
    // resolves the group identifier verbatim at runtime.
    expect(swift).toMatch(/private let kAppGroup = "J6NNRLDUG4\.group\.dev\.darshit\.daak"/);
  });

  it('refuses to start over a file identity instead of silently re-pairing', () => {
    // D16.12.6. b122254 shipped the UDL's plain constructor, so any Mac that ran
    // it wrote its Ed25519 identity to Documents/daak/keys. This build asks the
    // keychain instead, finds nothing, and import_from_store's (None, None) arm
    // MINTS A NEW IDENTITY -- the same silent re-pair R40(c) exists to forbid,
    // reached by the opposite route: the start succeeds and every peer sees a
    // different device. A guard is the only safe answer; migrating the file key
    // into the keychain would re-create the two-store bifurcation the file store
    // was removed to end, and deleting a user's identity is not ours to do.
    const swift = readFileSync(join(MACOS, 'Daak-macOS', 'Daak.swift'), 'utf8');
    expect(swift).toMatch(/fileExists\(atPath: legacyKeys\.path\)/);
    // And it REJECTS rather than warning: an error the user can see is the whole
    // difference between this and the silent re-pair.
    // ADJACENT, not "somewhere later in the file". The previous `[\s\S]*?`
    // form matched a `reject(` anywhere downstream; a reviewer kept every token
    // but moved the reject behind `if false` and the suite stayed green, which
    // is the silent re-pair this whole guard exists to stop.
    const GUARD = 'if FileManager.default.fileExists(atPath: legacyKeys.path) {';
    const guardAt = swift.indexOf(GUARD);
    expect(guardAt).toBeGreaterThan(-1);
    const body = swift.slice(guardAt + GUARD.length, swift.indexOf('\n        }', guardAt));
    expect(body).toMatch(/reject\(/);
    // And the guard is built from dataRoot plus the store's own directory name,
    // so pointing it at the WRONG path -- deletingLastPathComponent(), say --
    // leaves it never firing, indistinguishable from no guard to a token check.
    expect(swift).toMatch(
      /let legacyKeys = dataRoot\.appendingPathComponent\("keys", isDirectory: true\)/,
    );
    // Guarded BEFORE the engine is constructed, or the keychain start has
    // already minted the replacement identity by the time we notice the file.
    expect(swift.indexOf('fileExists(atPath: legacyKeys.path)')).toBeLessThan(
      swift.indexOf('DaakEngine.newWithStore(store: KeychainSecureStore(), sink: self)'),
    );
  });
});
