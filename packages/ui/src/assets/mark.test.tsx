import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MARK_URI } from './mark';

/**
 * The wordmark ships as one embedded PNG data URI, and the old file assets are
 * dead. A bundler asset id is a NUMBER, and Metro never served the PNG: it
 * answered 404 for every URL it can build, so the Image painted nothing.
 */
describe('mark assets', () => {
  it('exports the mark as an embedded PNG data URI', () => {
    expect(MARK_URI).toMatch(/^data:image\/png;base64,/);
  });

  it('keeps no dead mark assets', () => {
    const dead = ['daak-mark.png', 'daak-mark@2x.png', 'daak-mark@3x.png', 'png.d.ts'];
    for (const name of dead) {
      expect(existsSync(join(__dirname, name))).toBe(false);
    }
  });
});
