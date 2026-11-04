import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// This gate reads the native sources of rn-share and rn-fspaths.
// A reject message and a log line must not show a path, a file name, or an error object.
// React Native copies the userInfo of an NSError into the JavaScript error.
// React Native also copies the message of a Throwable. Both can hold a path.

const MODULES = join(__dirname, '..', '..');
const ROOTS = [join(MODULES, 'rn-share'), join(MODULES, 'rn-fspaths')];
const SOURCE = /\.(swift|kt|mm|m)$/;
const SKIP_DIRS = new Set(['build', 'node_modules', '.gradle']);

// The calls that make a reject message, a log line, or a message that JavaScript reads.
// FolderPickError (Kotlin) holds a message that a later reject sends to JavaScript.
const CALL = /(?<![A-Za-z_])(reject|NSLog|Log\.[wedi]|os_log|FolderPickError)\(/g;

// The only interpolations that a message can hold. Each one is a number, a Bool,
// an error domain, an error code, or an exception class name.
const SAFE_INTERPOLATION = [
  /^needed$/,
  /^stale$/,
  /^\(error as NSError\)\.(domain|code)$/,
  /^\w+\.javaClass\.simpleName$/,
];

// Allowed exception: this line sends the message of a FolderPickError.
// The gate checks every FolderPickError message, so that message has no path.
const ALLOWED_LINES = new Set(['promise.reject(e.code, e.message)']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...sourceFiles(join(dir, entry.name)));
    } else if (SOURCE.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** The arguments of the call that opens at `start`, or null when the call does not close on this line. */
function callArgs(line: string, start: number): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (let i = start; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      current += c;
      if (c === '\\') {
        current += line[i + 1] ?? '';
        i += 1;
      } else if (c === '"') {
        quoted = false;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
      current += c;
    } else if (c === '(' || c === '[' || c === '{') {
      depth += 1;
      current += c;
    } else if ((c === ')' || c === ']' || c === '}') && depth > 0) {
      depth -= 1;
      current += c;
    } else if (c === ')') {
      args.push(current.trim());
      return args;
    } else if (c === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  return null;
}

const isLiteral = (arg: string): boolean => /^@?"(?:[^"\\]|\\.)*"$/.test(arg);

/** The interpolated expressions in a Swift or Kotlin string literal. */
function interpolations(literal: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < literal.length; i += 1) {
    const swift = literal.startsWith('\\(', i);
    const kotlinBlock = literal.startsWith('${', i);
    if (swift || kotlinBlock) {
      const open = swift ? '(' : '{';
      const close = swift ? ')' : '}';
      let depth = 1;
      let j = i + 2;
      for (; j < literal.length && depth > 0; j += 1) {
        if (literal[j] === open) depth += 1;
        if (literal[j] === close) depth -= 1;
      }
      out.push(literal.slice(i + 2, j - 1));
      i = j - 1;
      continue;
    }
    const bare = /^\$([A-Za-z_]\w*)/.exec(literal.slice(i));
    if (bare) {
      out.push(bare[1]);
      i += bare[0].length - 1;
    }
  }
  return out;
}

function problems(line: string): string[] {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return [];
  const found: string[] = [];
  for (const match of trimmed.matchAll(CALL)) {
    const name = match[1];
    // A class declaration is not a call.
    if (trimmed.slice(0, match.index).endsWith('class ')) continue;
    const args = callArgs(trimmed, (match.index ?? 0) + match[0].length);
    if (args === null) {
      found.push(`${name}: the call does not close on its line, so the gate cannot read it`);
      continue;
    }
    if (ALLOWED_LINES.has(trimmed.replace(/^return /, ''))) continue;
    // NSLog and os_log get one message. The other calls get a code or a tag first.
    const messages = name === 'NSLog' || name === 'os_log' ? args : args.slice(1, 2);
    const extra = name === 'NSLog' || name === 'os_log' ? args.slice(1) : args.slice(2);
    for (const message of messages) {
      if (!isLiteral(message)) {
        found.push(`${name}: the message is not a fixed string: ${message}`);
        continue;
      }
      // JavaScript can show a reject message. A message with a slash can be a path.
      if (name !== 'NSLog' && name !== 'os_log' && message.includes('/')) {
        found.push(`${name}: the message holds a slash: ${message}`);
      }
      for (const expr of interpolations(message)) {
        if (!SAFE_INTERPOLATION.some((safe) => safe.test(expr))) {
          found.push(`${name}: the message interpolates ${expr}`);
        }
      }
    }
    for (const arg of extra) {
      if (!(name === 'reject' && arg === 'nil')) {
        found.push(`${name}: an extra argument passes an object: ${arg}`);
      }
    }
    if (/localizedDescription|\.message\b/.test(args.join(','))) {
      found.push(`${name}: the call reads an error text`);
    }
  }
  return found;
}

describe('native error text and logs', () => {
  it('has no path, no file name, and no error object in a reject or a log call', () => {
    const files = ROOTS.flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(0);
    const offending: string[] = [];
    for (const file of files) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, n) => {
          for (const p of problems(line)) {
            offending.push(`${relative(MODULES, file)}:${n + 1}: ${p}`);
          }
        });
    }
    expect(offending).toEqual([]);
  });

  it('finds the leaks that the gate must catch', () => {
    expect(problems('NSLog("Daak: could not move \\(src.lastPathComponent): \\(error)")')).toHaveLength(2);
    expect(problems('reject("E_DISCARD", "deleted: \\(error.localizedDescription)", error)').length).toBeGreaterThan(0);
    expect(problems('promise.reject("E_FSPATHS", t)')).toHaveLength(1);
    expect(problems('promise.reject("E_NOT_PICKED_COPY", "refused: $path is bad")')).toHaveLength(1);
    expect(problems('android.util.Log.w("DaakFsPaths", "removed", it)')).toHaveLength(1);
    expect(problems('android.util.Log.w("DaakFsPaths", "source: ${src.name}")')).toHaveLength(1);
    expect(problems('reject(@"E_BAD_DEVICES", error.localizedDescription ?: @"bad", error);').length).toBeGreaterThan(0);
    expect(problems('reject("E_X", "/var/mobile/a.txt", nil)')).toHaveLength(1);
    expect(problems('reject("NO_SPACE", "NO_SPACE:\\(needed)", nil)')).toEqual([]);
    expect(problems('NSLog("Daak: E_X (\\((error as NSError).domain) \\((error as NSError).code))")')).toEqual([]);
  });
});
