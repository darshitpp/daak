import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// proto/codegen.sh installs json-schema-to-typescript into a scratch directory.
// Without a lockfile, its transitive dependencies float, and a hijacked release
// would run on the developer's host and in CI. The script must install from a
// committed lockfile and refuse any drift.
const proto = join(__dirname, '..', '..', '..', 'proto');
const script = readFileSync(join(proto, 'codegen.sh'), 'utf8');
const lockPath = join(proto, 'codegen.pnpm-lock.yaml');

describe('proto/codegen.sh dependency install', () => {
  it('has a committed lockfile', () => {
    expect(existsSync(lockPath)).toBe(true);
  });

  it('installs from that lockfile and refuses drift', () => {
    expect(script).toMatch(/codegen\.pnpm-lock\.yaml/);
    expect(script).toMatch(/pnpm install[^\n]*--frozen-lockfile/);
  });

  it('locks the version that the script pins', () => {
    const version = script.match(/JSON2TS_VERSION="([^"]+)"/)?.[1];
    expect(version).toBeTruthy();
    expect(readFileSync(lockPath, 'utf8')).toContain(`json-schema-to-typescript@${version}`);
  });
});
