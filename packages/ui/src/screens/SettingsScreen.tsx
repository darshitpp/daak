import React, { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useEngine } from '../EngineContext';

export function SettingsScreen() {
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
    </View>
  );
}
