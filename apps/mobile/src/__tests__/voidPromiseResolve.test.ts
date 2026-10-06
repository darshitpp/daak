import { readFileSync } from 'fs';
import { join } from 'path';

// A user on Android tapped "Show QR" and the pairing screen rendered the error
// text `Cannot convert argument of type class kotlin.Unit` instead of a code.
//
// The cause is in DaakModule.kt, not in React Native. Every UniFFI method the
// UDL declares as `void` returns `Unit` in the generated Kotlin. React Native
// 0.76.5 converts the value a Promise is resolved with through
// Arguments.fromJavaArgs, which handles Boolean, Integer, Double, Float,
// String, WritableNativeMap and WritableNativeArray -- and has no case for
// kotlin.Unit, so it throws. The Java `void` return type does NOT save it: the
// Kotlin lambda hands `resolve` the value, and `resolve` calls
// `promise.resolve(block())` with it.
//
// So every engine method that returns Unit must resolve with `null` instead.
// Two routes reach a promise in DaakModule.kt, and both are pinned:
//   promise.resolve(null)          -- start() does it inline on its own Thread;
//   resolve(promise) { ...; null }  -- the helper passes the LAST statement of
//                                     the lambda to promise.resolve(block()).
//
// Scope: the `void` methods of `interface DaakEngine` in the UDL, and nothing
// else. SecureStore.set, SecureStore.delete and EventSink.on_event are void too,
// but they are callbacks and not engine methods: they have no promise and no
// DaakModule.kt override.
//
// There is no JVM source set in this module, so this is a source-level pin, in
// the same shape as androidFfiWiring.test.ts.
const repo = '../../../../';
const moduleKt = 'apps/mobile/android/app/src/main/java/dev/darshit/daak/DaakModule.kt';
const udl = 'crates/daak-ffi/src/daak.udl';

const read = (p: string) => readFileSync(join(__dirname, repo, p), 'utf8');

/** The Kotlin engine method name for a UDL method name. */
const camel = (snake: string) => snake.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());

/** The text INSIDE `interface DaakEngine { ... }`, so the callback interfaces of
 *  the same UDL cannot contribute a method to the pin. */
const engineInterface = (): string => {
  const src = read(udl);
  const open = /interface\s+DaakEngine\s*\{/.exec(src);
  if (!open) throw new Error('the UDL declares no interface DaakEngine');
  let depth = 0;
  for (let i = open.index + open[0].length - 1; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open.index + open[0].length, i);
    }
  }
  throw new Error('the UDL interface DaakEngine is never closed');
};

const udlVoid = Array.from(
  engineInterface().matchAll(/\[Throws=\w+\]\s*void\s+(\w+)\s*\(/g),
).map((m) => m[1]);

// The inverse list. A method that returns a VALUE must resolve with that value.
// Appending `; null` to one of these throws the value away, and the void pin
// below never sees it because the method is not on that list. So the pin needs
// both halves: the void list says "must be null", and this list says "must not".
const udlValue = Array.from(
  engineInterface().matchAll(/\[Throws=\w+\]\s+(?!void\b)(\w+)\s+(\w+)\s*\(/g),
)
  // `ffi_event_json` is declared in the same block but is a free FUNCTION, not
  // an interface method: it has no promise and no DaakModule.kt override. The
  // two constructors are named shapes, not call sites either.
  .filter(([, , name]) => !/^(constructor|new_with_store|ffi_event_json)$/.test(name))
  .map(([, , name]) => name);

/** Drop `//` comment text, keeping the line structure. */
const stripComments = (s: string): string => s.replace(/[ \t]*\/\/[^\n]*/g, '');

/** The statements of a block body, one per line, comments and blanks gone. */
const statements = (s: string): string[] =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');

/** The index just past the `)` that closes the parameter list whose `(` is at
 *  `open - 1`. Counts nesting, so a default argument cannot end it early. */
const closeParen = (s: string, from: number): number => {
  let depth = 1;
  for (let i = from; i < s.length; i += 1) {
    if (s[i] === '(') depth += 1;
    else if (s[i] === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
};

/** The index just past the `}` that matches the `{` at `open`. */
const closeBrace = (s: string, open: number): number => {
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === '{') depth += 1;
    else if (s[i] === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
};

/** The first index at or after `from` that is not a space, a tab, a newline or a
 *  `//` comment line. Comments are SKIPPED, not read: cancel() puts two of them
 *  between its parameter list and its `=`, and they are not the body. */
const skipGap = (s: string, from: number): number => {
  let i = from;
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i += 1;
    if (!s.startsWith('//', i)) return i;
    const nl = s.indexOf('\n', i);
    if (nl < 0) return s.length;
    i = nl + 1;
  }
};

/** The body of `override fun NAME(...)` in DaakModule.kt: the text from the end
 *  of its parameter list to the end of the method, comments removed.
 *
 *  Both Kotlin body shapes occur in this file, and the difference is the whole
 *  reason an earlier version of this pin mis-read every method. A BLOCK body
 *  follows the parameter list with `{` and ends at the matching `}`. An
 *  EXPRESSION body follows it with `=`, has no braces of its own, and ends at the
 *  newline where no brace is left open -- which is why the walk must NOT stop at
 *  the first newline, because `= resolve(promise) { ... }` and the
 *  `= <comment>\n resolve(promise) { ... }` form both put one there first.
 */
const methodBody = (name: string, src: string): string => {
  const decl = new RegExp('override\\s+fun\\s+' + name + '\\s*\\(').exec(src);
  if (!decl) throw new Error(moduleKt + ' declares no override fun ' + name);
  const afterParams = closeParen(src, decl.index + decl[0].length);
  if (afterParams < 0) throw new Error('unclosed parameter list on ' + name);

  const at = skipGap(src, afterParams);
  if (src[at] === '{') return src.slice(at + 1, closeBrace(src, at) - 1);
  if (src[at] !== '=' || src[at + 1] === '=') {
    throw new Error(name + ' has neither a block body nor an expression body');
  }

  // An expression body: from the first token AFTER the `=` to the newline that
  // leaves the brace depth at zero. Starting after the `=` is what makes the
  // multi-line shape readable, because a newline sits directly after the `=` on
  // its own. A string literal is skipped whole, so a `"` in it cannot open a
  // string that then swallows the rest of the file.
  let depth = 0;
  let quote: string | null = null;
  const from = skipGap(src, at + 1);
  for (let i = from; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === '\n' && depth <= 0) return src.slice(from, i);
  }
  return src.slice(from);
};

describe('a void UniFFI method must not resolve its promise with Unit', () => {
  // Comments come out FIRST, because they are not code. cancel() puts two of
  // them between its parameter list and its `=`, and the file header has a `"`
  // inside one. Reading either as Kotlin makes the walk below start or end in
  // the wrong place.
  const src = stripComments(read(moduleKt));

  it('the UDL declares the void engine methods the pin covers', () => {
    // If this ever goes to zero the pin below has nothing left to check, and a
    // green suite would mean nothing rather than that the defect is gone.
    expect(udlVoid.length).toBeGreaterThan(5);
    expect(udlVoid.map(camel).sort()).toEqual([
      'armHostPairing',
      'cancel',
      'deleteQuarantined',
      'offerPairing',
      // R42p: void in the UDL, and overridden on all three native modules.
      'replaceInboxPaths',
      'retry',
      'retryItem',
      // R42f: revoke_pairing is void in the UDL and overridden on the native
      // modules, so it belongs in the same pin as the other void engine verbs.
      'revokePairing',
      'setDisplayName',
      'setPresence',
      'shutdown',
      'start',
    ]);
  });

  it('reads the engine interface only, and not the callback interfaces', () => {
    // SecureStore.set, SecureStore.delete and EventSink.on_event are void in the
    // same UDL. None of them is an engine method: each has no promise and no
    // DaakModule.kt override, so a pin that swept them up would look for a
    // Kotlin method that must never exist.
    expect(udlVoid).not.toContain('set');
    expect(udlVoid).not.toContain('delete');
    expect(udlVoid).not.toContain('on_event');
  });

  it.each(udlValue.map(camel))('%s resolves with its value, not null', (name) => {
    // The other half of the void pin. A value-returning method resolved with
    // null hands JS nothing, so listDevices() reports an empty peer list and
    // pairingBundle() yields an empty code. Nothing else in the suite catches
    // that, because the void list never names a value-returning method.
    const body = methodBody(name, src);

    const direct = Array.from(body.matchAll(/promise\.resolve\(\s*([^)]*?)\s*\)/g));
    for (const [, arg] of direct) expect([name, arg]).not.toBe('null');

    const helpers = Array.from(body.matchAll(/\bresolve\(promise\)\s*\{/g));
    for (const helper of helpers) {
      const open = helper.index + helper[0].length - 1;
      const inner = body.slice(open + 1, closeBrace(body, open) - 1);
      const last = statements(inner).pop() ?? '';
      expect([name, last]).not.toEqual([name, expect.stringMatching(/\bnull$/)]);
    }

    expect(direct.length + helpers.length).toBeGreaterThan(0);
  });

  it.each(udlVoid.map(camel))('%s resolves with null, not Unit', (name) => {
    const body = methodBody(name, src);

    // Route 1, start(): it calls promise.resolve(ARG) on its own Thread, so ARG
    // has to be null outright. Unit is not one of the types fromJavaArgs knows.
    const direct = Array.from(body.matchAll(/promise\.resolve\(\s*([^)]*?)\s*\)/g));
    for (const [, arg] of direct) expect([name, arg]).toEqual([name, 'null']);

    // Route 2, the resolve() helper: promise.resolve(block()) is handed the value
    // of the lambda, so the LAST statement is what has to be null. That covers
    // the one-line `{ call(); null }` shape and the several-statement block
    // shape alike, because both end in a null statement.
    const helpers = Array.from(body.matchAll(/\bresolve\(promise\)\s*\{/g));
    for (const helper of helpers) {
      const open = helper.index + helper[0].length - 1;
      const inner = body.slice(open + 1, closeBrace(body, open) - 1);
      const last = statements(inner).pop() ?? '';
      expect([name, last]).toEqual([name, expect.stringMatching(/\bnull$/)]);
    }

    // One of the two routes has to be present. Otherwise the checks above read
    // an empty body and pass on a method that never resolves at all, which is
    // the failure this pin exists to make loud.
    expect([name, direct.length + helpers.length]).toEqual([name, expect.any(Number)]);
    expect(direct.length + helpers.length).toBeGreaterThan(0);
  });
});
