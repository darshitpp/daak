import { readFileSync } from 'fs';
import { join } from 'path';

// SOURCE PIN. No Android test source set exists on this host.
// ShareTargetActivity is exported. Another app picks the EXTRA_STREAM uri, and
// copyToCache opens it inside the Daak process. A file:// uri or a uri on the
// Daak FileProvider would copy a private Daak file (such as the database) into
// the share inbox. copyToCache must refuse both.
const file = join(
  __dirname,
  '../../../../modules/rn-share/android/src/main/java/dev/darshit/daak/share/ShareInbox.kt',
);

describe('ShareInbox.copyToCache input guard', () => {
  const src = readFileSync(file, 'utf8');
  // The refusal lives in requireForeignContentUri. copyToCache and materialize
  // both call it, so the text exists once.
  const start = src.indexOf('fun requireForeignContentUri(');
  const body = src.slice(start, src.indexOf('fun copyToCache(', start));
  const copyStart = src.indexOf('fun copyToCache(');
  const copyBody = src.slice(copyStart, src.indexOf('openInputStream', copyStart));

  it('copyToCache calls the refusal before it opens the stream', () => {
    expect(copyBody).toContain('requireForeignContentUri(ctx, uri)');
  });

  it('refuses a uri that is not a content uri before it opens the stream', () => {
    expect(body).toContain('SCHEME_CONTENT');
    expect(body).toContain('SecurityException');
  });

  it('refuses a uri on an authority of this app', () => {
    expect(body).toContain('ctx.packageName');
  });

  // The final review (M1): Android adds a user prefix (`10@`) to the uri of a
  // share from another profile. A digits-only prefix is allowed. The checks for
  // this app then apply to the host after the prefix. The regex of the source
  // runs here on the encoded authority.
  const authorityRule = (() => {
    const m = /FOREIGN_AUTHORITY = Regex\("{3}(.+?)"{3}\)/.exec(src);
    if (!m) throw new Error('ShareInbox.kt has no FOREIGN_AUTHORITY regex');
    return new RegExp(`^(?:${m[1]})$`);
  })();
  const own = 'dev.darshit.daak';
  // The JavaScript form of the guard: the regex, then the own-package check on the host.
  const allowed = (encoded: string) => {
    const m = authorityRule.exec(encoded);
    return m !== null && !m[1].startsWith(own);
  };

  it('allows a digits-only user prefix of another app: 10@com.example.provider', () => {
    expect(allowed('10@com.example.provider')).toBe(true);
    expect(allowed('com.example.provider')).toBe(true);
  });

  it('refuses the own package after a user prefix: 0@dev.darshit.daak.fileprovider', () => {
    expect(allowed('0@dev.darshit.daak.fileprovider')).toBe(false);
    expect(allowed('dev.darshit.daak.fileprovider')).toBe(false);
  });

  it('refuses a percent-encoded prefix and any other user info', () => {
    expect(allowed('0%40dev.darshit.daak.fileprovider')).toBe(false);
    expect(allowed('0%40com.example.provider')).toBe(false);
    expect(allowed('user@com.example.provider')).toBe(false);
    expect(allowed('1@2@com.example.provider')).toBe(false);
    expect(allowed('')).toBe(false);
  });

  it('applies the regex to the encoded authority and the own checks to the host', () => {
    expect(body).toContain('FOREIGN_AUTHORITY.matchEntire(');
    expect(body).toContain('uri.encodedAuthority');
    expect(body).toContain('host == null');
    expect(body).toContain('host.startsWith(ctx.packageName)');
    expect(body).toContain('isOwnProvider(ctx, host)');
    expect(body).not.toContain('uri.userInfo != null');
  });

  it('refuses a uri when the provider of the authority belongs to this app', () => {
    expect(body).toContain('resolveContentProvider(');
    expect(body).toContain('?.packageName == ctx.packageName');
  });

  it('refuses a uri when the provider lookup fails', () => {
    const lookup = body.slice(body.indexOf('resolveContentProvider('));
    expect(lookup).toMatch(/catch \(_: Throwable\) \{\s*true/);
  });

  it('the refusal message holds no uri', () => {
    expect(body).toContain('SecurityException("refused uri")');
    expect(body).not.toMatch(/SecurityException\([^)]*\$/);
  });

  it('the source read failure message holds no uri', () => {
    expect(src).toContain('IOException("cannot open the source")');
    expect(src).not.toContain('cannot open $uri');
  });

  it('safeLeaf limits the name to 200 bytes and keeps a short extension', () => {
    const leaf = src.slice(src.indexOf('fun safeLeaf('));
    expect(src).toContain('MAX_LEAF_BYTES = 200');
    expect(src).toContain('MAX_EXT_CHARS = 16');
    expect(leaf).toContain('limitLeaf(');
    const limit = src.slice(src.indexOf('fun limitLeaf('));
    expect(limit).toContain('Charsets.UTF_8');
    expect(limit).toContain('codePointAt(');
  });
});
