import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { InboxEntry } from '@daak/core';
import { useEngine } from '../EngineContext';

export function HistoryScreen() {
  const engine = useEngine();
  const [inbox, setInbox] = useState<InboxEntry[]>([]);

  useEffect(() => {
    const refresh = () => void engine.listInbox().then(setInbox);
    refresh();
    return engine.on((e) => {
      if (e.type === 'inbox.received') setInbox((prev) => [e.payload, ...prev]);
    });
  }, [engine]);

  return (
    <View>
      {inbox.map((i) => <Text key={i.payloadId}>{i.summary}</Text>)}
    </View>
  );
}
