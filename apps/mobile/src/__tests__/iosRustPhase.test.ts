import { readFileSync } from 'fs';
import { join } from 'path';

// SOURCE PIN. The Rust phase lists no Rust source as an input. Without
// alwaysOutOfDate, a Rust change can leave a stale libdaak_ffi.a in the app.
describe('Xcode phase Generate UniFFI bindings + Rust staticlib', () => {
  const pbx = readFileSync(
    join(__dirname, '../../ios/Daak.xcodeproj/project.pbxproj'),
    'utf8',
  );
  const start = pbx.indexOf('/* Generate UniFFI bindings + Rust staticlib */ = {');
  const block = pbx.slice(start, pbx.indexOf('};', pbx.indexOf('shellScript', start)));

  it('exists', () => {
    expect(start).toBeGreaterThan(-1);
  });

  it('runs on every build', () => {
    expect(block).toMatch(/alwaysOutOfDate = 1;/);
  });
});
