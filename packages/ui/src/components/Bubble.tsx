import React from 'react';
import { Pressable, Text, View } from 'react-native';
import type { ThreadItem } from '@daak/core';
import { ui } from '../theme';
import { humanBytes } from '../screens/quarantine-facts';
import { itemKey } from '../screens/thread-merge';

export type BubbleKind = 'text' | 'file' | 'held' | 'failed' | 'waiting' | 'stopped';

/** A Text node with 1 MiB of characters freezes layout. Show a prefix; Copy still gets all of it. */
export const TEXT_PREVIEW_CHARS = 4000;

export function bubbleKind(i: ThreadItem): BubbleKind {
  const out = i.direction === 'out';
  if (i.state === 'quarantined') return 'held';
  if (i.state === 'failed' || (out && i.transferState === 'failed')) return 'failed';
  if (out && i.transferState === 'canceled') return 'stopped';
  if (out && i.transferState === 'queued') return 'waiting';
  return i.type === 'text' ? 'text' : 'file';
}

/** "Just now", a clock time for today, a short date for an older day. */
export function whenLabel(atSeconds: number, nowMs: number = Date.now()): string {
  const at = new Date(atSeconds * 1000);
  const now = new Date(nowMs);
  if (nowMs - at.getTime() < 60_000) return 'Just now';
  if (at.toDateString() === now.toDateString()) {
    return at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return at.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function Quick({ label, text, onPress, testID }: { label: string; text: string; onPress: () => void; testID?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [ui.quick, pressed ? ui.pressed : null]}
    >
      <Text style={ui.quickTxt}>{text}</Text>
    </Pressable>
  );
}

/** Cut at a code point, so a surrogate pair stays whole. */
function prefix(text: string): { shown: string; cut: boolean } {
  if (text.length <= TEXT_PREVIEW_CHARS) return { shown: text, cut: false };
  let end = TEXT_PREVIEW_CHARS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { shown: text.slice(0, end) + '…', cut: true };
}

/**
 * One thread item. A button shows only when the caller passes its callback, so
 * a host without a verb draws no dead button. Retry shows for a failed
 * OUTBOUND item only: the protocol is push-only, and a receiver cannot ask for
 * the bytes again.
 */
export function Bubble({ item, onCopy, onPreview, onShare, onOpenHeld, onRetry, onStop }: {
  item: ThreadItem;
  onCopy?: (text: string) => void;
  onPreview?: (i: ThreadItem) => void;
  onShare?: (i: ThreadItem) => void;
  onOpenHeld?: (i: ThreadItem) => void;
  onRetry?: (i: ThreadItem) => void;
  onStop?: (i: ThreadItem) => void;
}) {
  const kind = bubbleKind(item);
  const out = item.direction === 'out';
  const name = item.name ?? 'file';
  const size = item.size === null ? '' : humanBytes(item.size);
  const hasPath = item.destPath !== null;

  let content: React.ReactNode;
  if (item.type === 'text' && kind !== 'held') {
    if (item.text === null) {
      content = <Text style={ui.hint}>This text could not be read.</Text>;
    } else {
      const { shown, cut } = prefix(item.text);
      content = (
        <>
          <Text style={ui.bubbleTxt} testID="bubble-text" selectable>{shown}</Text>
          {cut ? <Text style={ui.hint}>Showing the first 4000 characters. Copy text to get all of it.</Text> : null}
        </>
      );
    }
  } else {
    // Design `msgFileHTML`: the size line, then " · Held back" for a held item.
    const receiving = !out && (item.state === 'pending' || item.state === 'receiving' || item.state === 'verifying');
    const sub = [size, kind === 'held' ? 'Held back' : receiving ? 'Receiving' : ''].filter(Boolean).join(' · ');
    // Design `.bubble-state`: "Couldn't send" and "Waiting to send". A failed
    // inbound item has no design, so its engine error stands in. "Stopped" is
    // also an addition.
    const state =
      kind === 'failed' ? (out ? "Couldn't send" : item.error ?? 'It did not arrive')
      : kind === 'waiting' ? 'Waiting to send'
      : kind === 'stopped' ? 'Stopped'
      : null;
    content = (
      <>
        <Text style={ui.rowTitle} numberOfLines={2}>{name}</Text>
        <Text style={ui.hint}>{sub}</Text>
        {state !== null ? <Text style={kind === 'failed' ? ui.bubbleState : ui.hint}>{state}</Text> : null}
      </>
    );
  }

  const bubble = (
    <View style={[ui.bubble, out ? ui.bubbleOut : null, kind === 'failed' || kind === 'held' ? ui.bubbleWarn : null]}>
      {content}
      <Text style={ui.msgWhen}>{kind === 'waiting' ? 'Waiting' : whenLabel(item.at)}</Text>
    </View>
  );

  return (
    <View style={[ui.msg, out ? ui.msgOut : ui.msgIn]} testID={`bubble-${itemKey(item)}`}>
      <View style={ui.msgLine}>
        {bubble}
        {kind === 'file' && onShare && hasPath ? (
          <Quick label={`Share ${name}`} text="↗" onPress={() => onShare(item)} />
        ) : null}
      </View>
      <View style={ui.msgActions}>
        {kind === 'text' && onCopy && item.text !== null ? (
          <Quick label="Copy text" text="Copy" onPress={() => onCopy(item.text ?? '')} />
        ) : null}
        {kind === 'file' && onPreview && hasPath ? (
          <Quick label={`Preview ${name}`} text="Preview" onPress={() => onPreview(item)} />
        ) : null}
        {kind === 'held' && onOpenHeld ? (
          <Quick label={`Review ${name}`} text="Review" onPress={() => onOpenHeld(item)} />
        ) : null}
        {kind === 'failed' && out && onRetry ? (
          <Quick label={`Retry sending ${name}`} text="Retry" onPress={() => onRetry(item)} />
        ) : null}
        {kind === 'waiting' && onStop ? (
          <Quick label={`Stop waiting to send ${name}`} text="Stop" onPress={() => onStop(item)} />
        ) : null}
      </View>
    </View>
  );
}

