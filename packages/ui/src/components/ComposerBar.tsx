import React from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

export function ComposerBar({ text, files, canSend, onChange, onSend }: {
  text: string; files: string[]; canSend: boolean; onChange: (t: string) => void; onSend: () => void;
}) {
  return (
    <View>
      <TextInput value={text} onChangeText={onChange} placeholder="Message" />
      <Text>{files.length} file(s)</Text>
      <Pressable accessibilityLabel="send" disabled={!canSend} onPress={onSend}>
        <Text>Send</Text>
      </Pressable>
    </View>
  );
}
