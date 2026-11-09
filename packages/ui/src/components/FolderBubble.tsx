import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { ui } from '../theme';
import { humanBytes } from '../screens/quarantine-facts';
import { folderStateWord, folderSub, type FolderRow } from '../screens/thread-groups';
import type { ThreadItem } from '@daak/core';
import { BubbleFill, Quick, fillStyles, whenLabel } from './Bubble';

/**
 * One bubble for a whole folder (design `msgFolderHTML`). It replaces the
 * bubbles of its files. A press on the bubble or on `Open` opens the folder
 * sheet. The bubble has no Retry: a retry is for one file, in the sheet.
 */
export function FolderBubble({ row, savedLine, onOpen, percentOf, onStopRunning }: {
  row: FolderRow;
  savedLine: string | null;
  onOpen: (row: FolderRow) => void;
  /** The percent of one file, 0 to 100. The bubble fills by the number of files at 100. */
  percentOf?: (item: ThreadItem) => number | undefined;
  /** Stops a transfer that runs now. Shows the Stop sending control. */
  onStopRunning?: () => void;
}) {
  const out = row.direction === 'out';
  const size = humanBytes(row.bytes);
  // A cut child list has unknown percents. Then the fill and the count stay off.
  const running = row.state === 'receiving' || row.state === 'sending';
  const fillOn = percentOf !== undefined && !row.cut && row.files > 0 && (running || row.state === 'failed');
  const doneCount = fillOn ? row.children.filter((c) => percentOf(c) === 100).length : undefined;
  const pct = doneCount === undefined ? 0 : Math.min(100, Math.floor((doneCount * 100) / row.files));
  const word = folderStateWord(row, doneCount);
  const warn = row.state === 'failed' || row.state === 'held';
  // A done received folder says where it went. A done sent folder says nothing.
  const line = word ?? (out ? null : savedLine);
  const shown = fillOn && running ? `${doneCount} of ${row.files} files` : line;
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
          style={({ pressed }) => [ui.bubble, out ? ui.bubbleOut : null, warn ? ui.bubbleWarn : null, fillOn ? fillStyles.clip : null, pressed ? ui.pressed : null]}
        >
          {fillOn ? <BubbleFill testID={`bubble-fill-${row.key}`} progress={pct} failed={row.state === 'failed'} done={false} /> : null}
          <Text style={ui.rowTitle} numberOfLines={2}>{row.name}</Text>
          <Text style={ui.hint}>{folderSub(row, size)}</Text>
          {shown !== null ? <Text style={warn ? ui.bubbleState : ui.hint}>{shown}</Text> : null}
          <Text style={ui.msgWhen}>{waiting ? 'Waiting' : whenLabel(row.at)}</Text>
        </Pressable>
      </View>
      <View style={ui.msgActions}>
        <Quick label={`Open ${row.name}`} text="Open" onPress={() => onOpen(row)} />
        {onStopRunning && fillOn && running ? (
          <Quick label="Stop sending" text="Stop" testID={`thread-stop-${row.transferId}`} onPress={onStopRunning} />
        ) : null}
      </View>
    </View>
  );
}
