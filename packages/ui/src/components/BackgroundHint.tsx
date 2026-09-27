import React from 'react';
import { Pressable, Text, View } from 'react-native';

/**
 * The keep-Daak-open-to-sync-now affordance, and copy only BY DEFAULT.
 *
 * WHY onOpen IS OPTIONAL: the plan wires it to engine.backgroundWake(), which
 * does not exist -- it arrives in Phase 7 Task 3 (R61/R4), and adding it would
 * be a UDL and wire change this phase did not spec. A required prop would force
 * every call site to hand a function wired to nothing, and a Pressable with no
 * real action is a dead button (R128). The prop stays so a caller CAN wire a
 * real action; no production call site passes one today, and the hint is honest
 * about what iOS actually decides.
 *
 * Rendered through the existing injected slot rather than inside SettingsScreen:
 * the host already injects a background notice there, and packages/ui must not
 * decide what a given platform's background story is.
 *
 * ponytail: one View, one line of copy, one conditional Pressable. A second
 * background-mode explainer is another string here, not another screen.
 */
export function BackgroundHint({ onOpen }: { onOpen?: () => void }) {
  return (
    <View accessibilityLabel="background-hint">
      <Text>Keep Daak open to sync now. iOS decides when background sync runs.</Text>
      {onOpen ? (
        <Pressable accessibilityLabel="open-daak" onPress={onOpen}>
          <Text>Sync now</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
