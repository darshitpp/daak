/**
 * Source with every comment removed, so a count of executable statements is a
 * count of STATEMENTS and not a count of how many times a rule is written
 * down. apps/desktop/index.js explains the single-engine.start rule at length
 * in prose (its header, the claim's header, and both start closures), and a raw
 * count over the unstripped file would therefore be meaningless.
 *
 * Written as a scanner rather than a regex-with-replacements because a string
 * literal containing a quote-plus-comment sequence would desync a naive strip,
 * and because the one thing this must not do is throw away a line of code.
 *
 * SHARED, and moved out of onboarding.spec.ts rather than copied into it: the
 * D1 pin and the tray-overlay source pin both need it, and two copies of a
 * scanner is two scanners that can drift.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  // The quote that a string literal is currently inside, or null.
  let quote: "'" | '"' | '`' | null = null;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (quote !== null) {
      if (source[i] === '\\') {
        out += two;
        i += 2;
        continue;
      }
      if (source[i] === quote) quote = null;
      out += source[i];
      i += 1;
      continue;
    }
    if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
      quote = source[i] as "'" | '"' | '`';
      out += source[i];
      i += 1;
      continue;
    }
    if (two === '//') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (two === '/*') {
      i += 2;
      while (i < source.length && source.slice(i, i + 2) !== '*/') i += 1;
      i += 2;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}
