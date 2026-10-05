import React from 'react';
import { View } from 'react-native';
import { ui } from '../theme';
import { Btn, Note } from './ds';

/**
 * The keep-Daak-open-to-sync-now affordance, and copy only BY DEFAULT.
 *
 * WHY THE DEFAULT BODY NAMES NO PLATFORM (R44): this component renders on iOS
 * and on Android, and packages/ui has no platform branch. A default that says
 * "iOS decides" prints a falsehood on Android. The default is therefore one
 * sentence that is true on both. A host that knows its platform passes its own
 * sentence through `body`; the copy branch lives in the host, not here.
 *
 * WHY onOpen IS OPTIONAL: the plan wires it to engine.backgroundWake(), which
 * does not exist -- it arrives in Phase 7 Task 3 (R61/R4), and adding it would
 * be a UDL and wire change this phase did not spec. A required prop would force
 * every call site to hand a function wired to nothing, and a Pressable with no
 * real action is a dead button (R128).
 */
export function BackgroundHint({ onOpen, body }: { onOpen?: () => void; body?: string }) {
  return (
    <View accessibilityLabel="background-hint">
      <Note
        title="It needs Daak open to sync now"
        body={body ?? 'Background transfers run while Daak is open unless you allow them.'}
      />
      {onOpen ? <Btn label="Sync now" variant="ghost" onPress={onOpen} testID="open-daak" block /> : null}
    </View>
  );
}
