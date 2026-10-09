import { readFileSync } from 'fs';
import { join } from 'path';

// SOURCE PIN. No Android test source set exists on this host.
// A FileProvider root at files-path "." serves every file under filesDir,
// including daak/daak.db and the wrapped identity. The roots must name only the
// received-files directory and the share inbox.
const res = '../../../../modules/';
const files = [
  'rn-fspaths/android/src/main/res/xml/daak_fspaths_file_paths.xml',
  'rn-share/android/src/main/res/xml/daak_file_paths.xml',
];

describe.each(files)('FileProvider roots in %s', (f) => {
  const xml = readFileSync(join(__dirname, res + f), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const filesRoots = [...xml.matchAll(/<files-path\b[^>]*\bpath="([^"]*)"/g)].map((m) => m[1]);

  it('does not serve all of filesDir', () => {
    expect(filesRoots.length).toBeGreaterThan(0);
    for (const path of filesRoots) {
      expect(['.', '', '/']).not.toContain(path);
    }
  });

  it('serves only the received-files directory and the share inbox', () => {
    expect([...filesRoots].sort()).toEqual(['daak/downloads/', 'share-inbox/']);
  });
});
