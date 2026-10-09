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
  const start = src.indexOf('fun copyToCache(');
  const body = src.slice(start, src.indexOf('openInputStream', start));

  it('refuses a uri that is not a content uri before it opens the stream', () => {
    expect(body).toContain('SCHEME_CONTENT');
    expect(body).toContain('SecurityException');
  });

  it('refuses a uri on an authority of this app', () => {
    expect(body).toContain('ctx.packageName');
  });
});
