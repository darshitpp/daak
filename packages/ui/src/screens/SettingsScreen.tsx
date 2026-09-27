import React, { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useEngine } from '../EngineContext';

/**
 * `background` is a SLOT, injected by the host app (apps/mobile passes the
 * BackgroundSyncNotice, which is the only thing that may call
 * requestBatteryExemption). packages/ui depends on @daak/core and nothing
 * else, and @daak/platform reaches TurboModules via getEnforcing at import
 * time -- importing it here would invert the dependency direction and break
 * every ui test that renders this screen. Desktop passes nothing, so the
 * default has to render a working screen too.
 */
export function SettingsScreen({ background }: { background?: React.ReactNode }) {
  const engine = useEngine();
  const [name, setName] = useState('');
  const [away, setAway] = useState(false);
  return (
    <View>
      <TextInput value={name} onChangeText={setName} placeholder="Display name" />
      <Pressable accessibilityLabel="save-name" onPress={() => void engine.setDisplayName(name)}>
        <Text>Save name</Text>
      </Pressable>
      <Pressable accessibilityLabel="toggle-presence" onPress={() => setAway((a) => !a)}>
        <Text>{away ? 'away' : 'online'}</Text>
      </Pressable>
      <Pressable accessibilityLabel="apply-presence" onPress={() => void engine.setPresence(away ? 'away' : 'online')}>
        <Text>Apply</Text>
      </Pressable>
      {background}
    </View>
  );
}
