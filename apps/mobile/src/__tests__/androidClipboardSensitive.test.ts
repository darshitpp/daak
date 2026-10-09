import { readFileSync } from 'fs';
import { join } from 'path';

// SOURCE PIN. No Android test source set exists on this host.
// Text that a peer sent may be private. Android 13 and later shows the clip in
// an on-screen preview unless the clip description is marked sensitive.
const file = join(
  __dirname,
  '../../../../modules/rn-clipboard/android/src/main/java/dev/darshit/daak/clipboard/DaakClipboardModule.kt',
);

it('marks the copied clip as sensitive', () => {
  const src = readFileSync(file, 'utf8');
  const start = src.indexOf('override fun setString(');
  const body = src.slice(start, src.indexOf('override fun getString(', start));
  expect(body).toContain('android.content.extra.IS_SENSITIVE');
});
