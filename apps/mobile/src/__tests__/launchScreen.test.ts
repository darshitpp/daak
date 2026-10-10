import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The launch screen is the first thing a person sees. The React Native template
// ships the words "Powered by React Native" in it, and that credit is not
// Daak's brand. A launch storyboard is a static asset with no runtime test, so
// this reads the source.
describe('the iOS launch screen', () => {
  const storyboard = join(__dirname, '..', '..', 'ios', 'Daak', 'LaunchScreen.storyboard');

  it('shows the app name', () => {
    expect(readFileSync(storyboard, 'utf8')).toContain('text="Daak"');
  });

  it('carries no React Native credit', () => {
    const xml = readFileSync(storyboard, 'utf8');
    expect(xml).not.toMatch(/Powered by React Native/);
    expect(xml).not.toMatch(/Built with React Native/);
  });
});
