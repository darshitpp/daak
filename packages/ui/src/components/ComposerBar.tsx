import React from 'react';
import { Text, TextInput, View } from 'react-native';
import { Btn } from './ds';
import { colors, ui } from '../theme';

export function ComposerBar({ text, files, canSend, onChange, onSend }: {
  text: string; files: string[]; canSend: boolean; onChange: (t: string) => void; onSend: () => void;
}) {
  return (
    <View style={ui.stackSm}>
      <TextInput
        value={text}
        onChangeText={onChange}
        placeholder="Message"
        placeholderTextColor={colors.meta}
        multiline
        style={[ui.input, { minHeight: 80, textAlignVertical: 'top' }]}
      />
      <Text style={ui.hint}>{files.length + ' file(s)'}</Text>
      <Btn label="Send" variant="primary" disabled={!canSend} onPress={onSend} testID="send" block />
    </View>
  );
}
