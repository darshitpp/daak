import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Btn } from './ds';
import { ui } from '../theme';

const base = (p: string): string => p.split(/[\\/]/).pop() ?? p;

export function AttachmentPicker({ files, onPick, onRemove }: {
  files: string[]; onPick: () => void; onRemove: (path: string) => void;
}) {
  return (
    <View style={ui.stackSm}>
      <Btn label="+  Add files" onPress={onPick} testID="pick-files" block />
      {files.map((p) => (
        <Pressable
          key={p}
          onPress={() => onRemove(p)}
          accessibilityLabel={`remove-${base(p)}`}
          style={({ pressed }) => [ui.chip, pressed ? ui.pressed : null]}
        >
          <Text style={ui.chipLabel} numberOfLines={1}>{base(p)}</Text>
          <Text style={ui.chipLabelOn}>×</Text>
        </Pressable>
      ))}
      <Text style={ui.hint}>
        {files.length === 0 ? 'No files added yet.' : `${files.length} file(s) ready.`}
      </Text>
    </View>
  );
}
