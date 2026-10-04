import { ui } from '../theme';
import type { ViewStyle } from 'react-native';

/**
 * A user reported that the Next button on the macOS naming screen does
 * nothing. The button was drawn below the bottom of the scroll view's hit
 * area, so it never received a press.
 *
 * The cause was `flexGrow` on the pinned action block while that block was a
 * child of the scroll content: it grew past the bottom of the visible area.
 * The block now sits outside the scroll view, and it must not grow.
 */
describe('the onboarding action bar', () => {
  it('must not grow inside the scroll container', () => {
    // Read through a style record: `ui` infers each literal style's exact
    // shape, so a removed property is a type error rather than `undefined`.
    expect((ui.onbActionsPinned as ViewStyle).flexGrow).toBeUndefined();
  });

  it('is a pinned bar with horizontal padding, not a growing content block', () => {
    expect(ui.onbActionsPinned.paddingHorizontal).toBeDefined();
    expect(ui.onbActionsPinned.paddingVertical).toBeDefined();
  });

  it('leaves a growing flex child as the scroll area', () => {
    expect(ui.onbScroll.flexGrow).toBe(1);
  });
});
