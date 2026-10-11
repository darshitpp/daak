import React from 'react';
import { Image, Text, View } from 'react-native';
import { colors, ui } from '../theme';
import { MARK_URI } from '../assets/mark';

/**
 * The mark, from an inline PNG data URI. react-native-svg is not a dependency of
 * this package, and a new native dependency needs the user's consent.
 *
 * It is NOT a file import, and `../assets/mark.ts` records the measurement: a
 * `daak-mark.png` import from this package resolved to
 * `httpServerLocation: "/assets/../../packages/ui/src/assets"` and Metro
 * answered 404 for every URL it can build, so the Image painted nothing and the
 * brand read "aak" on all three surfaces.
 */

/** The `--wm-size` of the design: `.wordmark` 17, `.wordmark--lg` 22. */
const SIZES = { sm: 17, lg: 22 } as const;

/**
 * The PNG holds the whole ink box, so no edge of the D is clipped. The ink
 * reaches half a stroke (0.875 SVG units) past the 13.5 x 14.5 viewBox of the
 * design. That is PAD times the size on each side. Negative margins give the
 * extra room back, so the D and the text stay where the design puts them.
 */
export const PAD = (0.875 * 1.024) / 13.5;

/**
 * "mark + aak". Every measure is a multiple of `size`, as in the design CSS:
 * the D is 1.024 wide and 1.1 high (the Image adds PAD on each side), it overlaps the text by 0.03, the gap
 * is 1 px, and the text has a letter spacing of -0.02. The row aligns on the
 * baseline. An Image has no baseline, so Yoga uses its bottom edge, which is
 * what an inline SVG does in CSS.
 */
export function Wordmark({ size = 'lg' }: { size?: number | 'sm' | 'lg' }) {
  const s = typeof size === 'number' ? size : SIZES[size];
  return (
    <View style={ui.wordmark} accessibilityLabel="Daak" accessibilityRole="image" testID="wordmark">
      <Image
        source={{ uri: MARK_URI }}
        accessible={false}
        resizeMode="contain"
        testID="wordmark-mark"
        style={{
          width: s * (1.024 + 2 * PAD),
          height: s * (1.1 + 2 * PAD),
          marginLeft: -s * PAD,
          marginBottom: -s * PAD,
          marginRight: 1 - s * (0.03 + PAD),
        }}
      />
      <Text
        style={{
          fontSize: s,
          lineHeight: s,
          fontWeight: '600',
          letterSpacing: -0.02 * s,
          color: colors.fg,
        }}
      >
        aak
      </Text>
    </View>
  );
}

