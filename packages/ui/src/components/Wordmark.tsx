import React from 'react';
import { Image, Text, View } from 'react-native';
import { colors, ui } from '../theme';
// Metro and the react-native jest preset both resolve a PNG import. Vitest in
// apps/desktop does not, so Step 5b adds a plugin there.
import MARK from '../assets/daak-mark.png';

/**
 * The mark as a bundled PNG. react-native-svg is not a dependency of this
 * package, and a new native dependency needs the user's consent. The file
 * keeps the viewBox cut of the design (see scripts/gen-icons.swift), so the
 * lockup matches the design pages. The default import needs the
 * module declaration in `packages/ui/src/assets/png.d.ts` (Step 5b).
 */

/** The `--wm-size` of the design: `.wordmark` 17, `.wordmark--lg` 22. */
const SIZES = { sm: 17, lg: 22 } as const;

/**
 * "mark + aak". Every measure is a multiple of `size`, as in the design CSS:
 * the mark is 1.024 wide and 1.1 high, it overlaps the text by 0.03, the gap
 * is 1 px, and the text has a letter spacing of -0.02. The row aligns on the
 * baseline. An Image has no baseline, so Yoga uses its bottom edge, which is
 * what an inline SVG does in CSS.
 */
export function Wordmark({ size = 'lg' }: { size?: number | 'sm' | 'lg' }) {
  const s = typeof size === 'number' ? size : SIZES[size];
  return (
    <View style={ui.wordmark} accessibilityLabel="Daak" accessibilityRole="image" testID="wordmark">
      <Image
        source={MARK}
        accessible={false}
        resizeMode="contain"
        testID="wordmark-mark"
        style={{ width: s * 1.024, height: s * 1.1, marginRight: 1 - s * 0.03 }}
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

