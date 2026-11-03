import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { ui } from '../theme';
import { humanBytes } from '../screens/quarantine-facts';
import { folderStateWord, folderSub, type FolderRow } from '../screens/thread-groups';
import { Quick, whenLabel } from './Bubble';

/**
 * One bubble for a whole folder (design `msgFolderHTML`). It replaces the
 * bubbles of its files. A press on the bubble or on `Open` opens the folder
 * sheet. The bubble has no Retry: a retry is for one file, in the sheet.
 */
export function FolderBubble({ row, savedLine, onOpen }: {
  row: FolderRow;
  savedLine: string | null;
  onOpen: (row: FolderRow) => void;
}) {
  const out = row.direction === 'out';
  const size = humanBytes(row.bytes);
  const word = folderStateWord(row);
  const warn = row.state === 'failed' || row.state === 'held';
  // A done received folder says where it went. A done sent folder says nothing.
  const line = word ?? (out ? null : savedLine);
  const waiting = row.state === 'waiting' || row.state === 'trying';
  const label = [
    `Folder ${row.name}`,
    `${row.files} ${row.files === 1 ? 'file' : 'files'}`,
    size,
    line === null ? '' : line.charAt(0).toLowerCase() + line.slice(1),
  ].filter(Boolean).join(', ');

  return (
    <View style={[ui.msg, out ? ui.msgOut : ui.msgIn]} testID={`bubble-folder-${row.key}`}>
      <View style={ui.msgLine}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={() => onOpen(row)}
          style={({ pressed }) => [ui.bubble, out ? ui.bubbleOut : null, warn ? ui.bubbleWarn : null, pressed ? ui.pressed : null]}
        >
          <Text style={ui.rowTitle} numberOfLines={2}>{row.name}</Text>
          <Text style={ui.hint}>{folderSub(row, size)}</Text>
          {line !== null ? <Text style={warn ? ui.bubbleState : ui.hint}>{line}</Text> : null}
          <Text style={ui.msgWhen}>{waiting ? 'Waiting' : whenLabel(row.at)}</Text>
        </Pressable>
      </View>
      <View style={ui.msgActions}>
        <Quick label={`Open ${row.name}`} text="Open" onPress={() => onOpen(row)} />
      </View>
    </View>
  );
}
