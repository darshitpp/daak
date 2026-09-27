import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { DeviceInfo } from '@daak/core';
import { ComposerScreen } from '@daak/ui';

/**
 * The app-side half of the DeviceCard Send button (R100: the shell stays
 * presentational). Tapping Send on a card routes here with that peer as the
 * destination -- the SAME component a share extension would eventually prefill,
 * so there is one send surface, not two.
 *
 * Deliberately NOT wired to drainInbound: a staged text/file share is still
 * all-or-nothing natively and R22 stands, so nothing here drains that inbox and
 * nothing here is allowed to.
 */
export function SendFlow({ peer, onCancel }: { peer: DeviceInfo | null; onCancel: () => void }) {
  if (peer === null) return null;
  return (
    <View>
      <ComposerScreen peerDeviceId={peer.deviceId} />
      <Pressable accessibilityLabel="composer-cancel" onPress={onCancel}>
        <Text>Cancel</Text>
      </Pressable>
    </View>
  );
}

/** Nothing rendered until App has a peer: the shell only supplies the callback. */
export function useSendPeer(): [DeviceInfo | null, (d: DeviceInfo) => void, () => void] {
  const [peer, setPeer] = useState<DeviceInfo | null>(null);
  return [peer, setPeer, () => setPeer(null)];
}
