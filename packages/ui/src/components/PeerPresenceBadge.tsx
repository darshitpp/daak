import React from 'react';
import { Text } from 'react-native';

/**
 * The peer liveness word plus the count of unsent items. The count is shown
 * only when it is above zero, so an idle peer carries no number.
 */
export function PeerPresenceBadge({ online, queued }: { online: boolean; queued: number }) {
  const label = online ? 'online' : 'offline';
  return <Text>{queued > 0 ? `${label} · ${queued} queued` : label}</Text>;
}
