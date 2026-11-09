import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import type { ThreadItem } from '@daak/core';
import { spacing, ui } from '../theme';
import { humanBytes } from '../screens/quarantine-facts';
import {
  folderStateWord,
  folderSub,
  folderTree,
  isLibraryPath,
  savedLine,
  type FolderPlaces,
  type FolderRow,
  type TreeNode,
} from '../screens/thread-groups';
import { BubbleFill, bubbleKind, clampProgress, fillStyles } from './Bubble';
import { Btn, Note } from './ds';
import { Sheet } from './Sheet';

/** The info banner under the sheet header. null when the files are in one plain place. */
function bannerOf(places: FolderPlaces | null, group: string, library?: string, saveFolder?: string): string | null {
  if (places === 'mixed' && library && saveFolder) {
    return `Photos and videos are in ${library}. Other files are in ${saveFolder} / ${group}.`;
  }
  if (places === 'library' && library) {
    // Android saves into a Daak folder of the Gallery. iOS makes an album.
    return library === 'Gallery'
      ? `Find it in ${library}, in the Daak folder under "${group}".`
      : `Find it in ${library}, under the album "${group}".`;
  }
  if (places === 'library-failed' && library && saveFolder) {
    return `Couldn't save to ${library}. All files are in ${saveFolder} / ${group}.`;
  }
  return null;
}

/** The state word of one file row. null for a file that needs no word. */
function fileWord(i: ThreadItem): string | null {
  const kind = bubbleKind(i);
  if (kind === 'held') return 'Held back';
  if (kind === 'failed') return i.direction === 'out' ? "Couldn't send" : i.error ?? 'It did not arrive';
  if (i.direction === 'in' && (i.state === 'pending' || i.state === 'receiving' || i.state === 'verifying')) return 'Receiving';
  return null;
}

/**
 * The folder detail (design `#cd-folder-sheet`): the files as a tree, the
 * location help, and the file actions. Retry is for one sent file. Stop shows
 * once, at the bottom, for a sent folder that waits or tries again: a stop ends the whole send.
 */
export function FolderSheet({
  row,
  open,
  onClose,
  onRetry,
  onStop,
  onPreview,
  onShare,
  canShare,
  onOpenHeld,
  percentOf,
  places,
  library,
  saveFolder,
}: {
  row: FolderRow;
  open: boolean;
  onClose: () => void;
  onRetry: (item: ThreadItem) => void;
  onStop: (row: FolderRow) => void;
  onPreview?: (item: ThreadItem) => void;
  onShare?: (item: ThreadItem) => void;
  /** The host can refuse to share one path. Default: every path. */
  canShare?: (item: ThreadItem) => boolean;
  onOpenHeld?: (item: ThreadItem) => void;
  /** The percent of one file, 0 to 100. Each file row fills by its own percent. */
  percentOf?: (item: ThreadItem) => number | undefined;
  places: FolderPlaces | null;
  library?: string;
  saveFolder?: string;
}) {
  const { height } = useWindowDimensions();
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const size = humanBytes(row.bytes);
  const sub = [folderSub(row, size), folderStateWord(row) ?? (row.direction === 'in' ? savedLine(places, library, saveFolder) : null)]
    .filter(Boolean)
    .join(' · ');
  const banner = bannerOf(places, row.name, library, saveFolder);
  const tagged = places === 'mixed' && library !== undefined && saveFolder !== undefined;

  const toggle = (path: string) =>
    setFolded((f) => {
      const next = new Set(f);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const fileRow = (i: ThreadItem, depth: number) => {
    const name = i.name ?? 'file';
    const kind = bubbleKind(i);
    const word = fileWord(i);
    const tag = tagged ? `In ${isLibraryPath(i.destPath) ? library : saveFolder}` : '';
    const line = [i.size === null ? '' : humanBytes(i.size), tag].filter(Boolean).join(' · ');
    const hasPath = kind === 'file' && i.destPath !== null;
    const pct = kind === 'file' && !(i.state === 'done' && i.transferState === 'done') ? clampProgress(percentOf?.(i)) : null;
    return (
      <View
        key={`f:${i.itemIndex}`}
        testID={`folder-file-${i.group?.rel ?? name}`}
        style={[ui.listRow, { paddingLeft: depth * spacing.lg }, pct !== null ? fillStyles.clip : null]}
      >
        {pct !== null ? <BubbleFill testID={`folder-file-fill-${i.group?.rel ?? name}`} progress={pct} failed={false} done={false} /> : null}
        <View style={ui.fill}>
          <Text style={ui.rowTitle} numberOfLines={1} ellipsizeMode="middle">{name}</Text>
          {line !== '' ? <Text style={ui.rowSub}>{line}</Text> : null}
        </View>
        {word !== null ? <Text style={kind === 'failed' || kind === 'held' ? ui.bubbleState : ui.hint}>{word}</Text> : null}
        {kind === 'failed' && i.direction === 'out' ? (
          <Btn label="Retry" accessibilityLabel={`Retry sending ${name}`} size="sm" variant="quiet" onPress={() => onRetry(i)} />
        ) : null}
        {kind === 'held' && onOpenHeld ? (
          <Btn label="Review" accessibilityLabel={`Review ${name}`} size="sm" variant="quiet" onPress={() => onOpenHeld(i)} />
        ) : null}
        {hasPath && onPreview ? (
          <Btn label="Preview" accessibilityLabel={`Preview ${name}`} size="sm" variant="quiet" onPress={() => onPreview(i)} />
        ) : null}
        {hasPath && onShare && (canShare?.(i) ?? true) ? (
          <Btn label="Share" accessibilityLabel={`Share ${name}`} size="sm" variant="quiet" onPress={() => onShare(i)} />
        ) : null}
      </View>
    );
  };

  const nodes = (list: TreeNode[], depth: number, parent: string): React.ReactNode[] =>
    list.flatMap((n) => {
      if (n.kind === 'file') return [fileRow(n.item, depth)];
      const path = parent === '' ? n.name : `${parent}/${n.name}`;
      const shut = folded.has(path);
      return [
        <Pressable
          key={`d:${path}`}
          testID={`folder-dir-${path}`}
          accessibilityRole="button"
          accessibilityLabel={`Folder ${n.name}`}
          accessibilityState={{ expanded: !shut }}
          onPress={() => toggle(path)}
          style={({ pressed }) => [ui.listRow, { paddingLeft: depth * spacing.lg }, pressed ? ui.pressed : null]}
        >
          <Text style={ui.rowTitle} numberOfLines={1}>{`${n.name}/`}</Text>
        </Pressable>,
        ...(shut ? [] : nodes(n.children, depth + 1, path)),
      ];
    });

  return (
    <Sheet
      open={open}
      title={row.name}
      onClose={onClose}
      actions={
        <>
          {row.direction === 'out' && (row.state === 'waiting' || row.state === 'trying') ? (
            <Btn label="Stop" variant="quiet" block onPress={() => onStop(row)} testID="folder-stop" />
          ) : null}
          <Btn label="Done" variant="quiet" block onPress={onClose} testID="folder-done" />
        </>
      }
    >
      <Text style={ui.hint}>{sub}</Text>
      {banner !== null ? (
        <Note body={banner} tone={places === 'library-failed' ? 'err' : 'plain'} testID="folder-banner" />
      ) : null}
      {row.cut ? <Text style={ui.hint}>{`Showing the first ${row.children.length} of ${row.files} files`}</Text> : null}
      <ScrollView style={{ maxHeight: Math.min(320, height * 0.4) }}>
        <View style={ui.list}>{nodes(folderTree(row.children), 0, '')}</View>
      </ScrollView>
    </Sheet>
  );
}
