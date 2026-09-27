import React from 'react';
import { FlatList, Pressable, Text } from 'react-native';

export function AttachmentPicker({ files, onPick, onRemove }: {
  files: string[]; onPick: () => void; onRemove: (path: string) => void;
}) {
  return (
    <>
      <Pressable onPress={onPick} accessibilityLabel="pick-files"><Text>Add files</Text></Pressable>
      <FlatList
        data={files}
        keyExtractor={(p) => p}
        renderItem={({ item }) => (
          <Pressable onPress={() => onRemove(item)} accessibilityLabel={`remove-${item}`}>
            <Text>{item.split('/').pop()}</Text>
          </Pressable>
        )}
      />
    </>
  );
}
