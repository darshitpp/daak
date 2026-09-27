import { readFileSync } from 'fs';
import { join } from 'path';

// There is no JVM/Android test source set in this module and no Android SDK in
// CI, so the manifest is the one piece of the share-target path that can still
// be asserted here. This is a source-level pin, not a behavioural test.
const manifest = readFileSync(
  join(__dirname, '../../android/app/src/main/AndroidManifest.xml'),
  'utf8',
);

function shareTarget(): string {
  const start = manifest.indexOf('android:name=".share.ShareTargetActivity"');
  expect(start).toBeGreaterThan(-1);
  const end = manifest.indexOf('</activity>', start);
  return manifest.slice(start, end);
}

describe('ShareTargetActivity manifest', () => {
  it('is not reused for a second share (no singleTop/singleTask)', () => {
    // singleTop with no onNewIntent override routes a share that lands while
    // the activity is at the top of its task to Activity.onNewIntent, which
    // does nothing: the share is never staged and never reported. The activity
    // stages one batch and finishes, so recreating it per intent is correct.
    expect(shareTarget()).not.toMatch(/android:launchMode="singleTop"/);
    expect(shareTarget()).not.toMatch(/android:launchMode="singleTask"/);
  });
});
