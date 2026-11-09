import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ThreadItem } from '@daak/core';
import { colors, ui } from '../theme';
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
  // paused is the retry back-off: the drain could not reach the peer and will
  // try again. It reads as waiting too, or a send that never left looks sent.
  if (out && (i.transferState === 'queued' || i.transferState === 'paused')) return 'waiting';
  return i.type === 'text' ? 'text' : 'file';
}

/** The error fill is drawn at this share of its tint. A full tint drops warnInk below 4.5:1. */
export const FAILED_FILL_OPACITY = 0.3;

const fillStyles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  fill: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: colors.fill, transformOrigin: 'left' },
  fillFailed: { backgroundColor: colors.errTint },
});

/** 0 to 100, never NaN. A value that is not a finite number gives null: no fill. */
function clampProgress(p: number | undefined): number | null {
  if (p === undefined || !Number.isFinite(p)) return null;
  return Math.min(100, Math.max(0, p));
}

/**
 * The fill of a file bubble. It is an absolute child that scales from the
 * left edge. Reduce motion sets the value with no animation. A done bubble
 * fades the fill out.
 */
function BubbleFill({ testID, progress, failed, done }: { testID: string; progress: number; failed: boolean; done: boolean }) {
  const scale = useRef(new Animated.Value(progress / 100)).current;
  const fade = useRef(new Animated.Value(1)).current;
  // null until the system answers. No animation starts before then.
  const [reduce, setReduce] = useState<boolean | null>(null);
  const shown = useRef(progress);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled().then((r) => { if (live) setReduce(r); }, () => { if (live) setReduce(false); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (reduce === null || shown.current === progress) return;
    shown.current = progress;
    if (reduce) { scale.setValue(progress / 100); return; }
    const a = Animated.timing(scale, { toValue: progress / 100, duration: 150, useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [progress, reduce, scale]);
  useEffect(() => {
    if (reduce === null) return;
    if (!done) { fade.setValue(1); return; }
    if (reduce) { fade.setValue(0); return; }
    const a = Animated.timing(fade, { toValue: 0, duration: 400, useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [done, reduce, fade]);
  return (
    <Animated.View
      testID={testID}
      pointerEvents="none"
      accessibilityValue={{ min: 0, max: 100, now: progress }}
      style={[
        fillStyles.fill,
        failed ? fillStyles.fillFailed : null,
        { opacity: failed ? Animated.multiply(fade, FAILED_FILL_OPACITY) : fade, transform: [{ scaleX: scale }] },
      ]}
    />
  );
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

export function Quick({ label, text, onPress, testID }: { label: string; text: string; onPress: () => void; testID?: string }) {
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
export function Bubble({ item, onCopy, onCopyWhole, onPreview, onShare, onOpenHeld, onRetry, onStop, progress, meta, onStopRunning }: {
  item: ThreadItem;
  onCopy?: (text: string) => void;
  /** Copy of a text that the engine cut (`textTruncated`): the host fetches the whole text. */
  onCopyWhole?: (i: ThreadItem) => void;
  onPreview?: (i: ThreadItem) => void;
  onShare?: (i: ThreadItem) => void;
  onOpenHeld?: (i: ThreadItem) => void;
  onRetry?: (i: ThreadItem) => void;
  onStop?: (i: ThreadItem) => void;
  /** 0 to 100. The file bubble fills from the left while a transfer runs. */
  progress?: number;
  /** A line under the size, such as "1.2 MB of 4 MB". */
  meta?: string;
  /** Stops a transfer that runs now. Shows the Stop sending control. */
  onStopRunning?: () => void;
}) {
  const kind = bubbleKind(item);
  const out = item.direction === 'out';
  const name = item.name ?? 'file';
  const size = item.size === null ? '' : humanBytes(item.size);
  const hasPath = item.destPath !== null;

  // Design .bubble-state: "Couldn't send" and "Waiting to send". A failed
  // inbound item has no design, so its engine error stands in. "Stopped" is
  // also an addition. The line shows on every bubble type, so it is not part
  // of the file branch.
  const state =
    kind === 'failed' ? (out ? "Couldn't send" : item.error ?? 'It did not arrive')
    : kind === 'waiting' ? (item.transferState === 'paused' ? 'Trying again' : 'Waiting to send')
    : kind === 'stopped' ? 'Stopped'
    : null;

  const pct = kind === 'file' || kind === 'failed' ? clampProgress(progress) : null;
  const isDone = item.state === 'done' && item.transferState === 'done';
  const fillOn = pct !== null && item.type !== 'text';

  let content: React.ReactNode;
  if (item.type === 'text' && kind !== 'held') {
    if (item.text === null) {
      content = <Text style={ui.hint}>This text could not be read.</Text>;
    } else {
      const { shown, cut } = prefix(item.text);
      content = (
        <>
          <Text style={ui.bubbleTxt} testID="bubble-text" selectable>{shown}</Text>
          {item.textTruncated === true ? (
            <Text style={ui.hint}>
              {onCopyWhole
                ? 'This text is too long to show in full. Copy text copies all of it.'
                : 'This text is too long to show in full. Copy text copies only the part you see.'}
            </Text>
          ) : cut ? (
            <Text style={ui.hint}>Showing the first 4000 characters. Copy text to get all of it.</Text>
          ) : null}
        </>
      );
    }
  } else {
    // Design `msgFileHTML`: the size line, then " · Held back" for a held item.
    const receiving = !out && (item.state === 'pending' || item.state === 'receiving' || item.state === 'verifying');
    const sub = [size, kind === 'held' ? 'Held back' : receiving ? 'Receiving' : ''].filter(Boolean).join(' · ');
    content = (
      <>
        <Text style={ui.rowTitle} numberOfLines={2}>{name}</Text>
        <Text style={ui.hint}>{sub}</Text>
        {meta ? <Text style={ui.hint}>{meta}</Text> : null}
      </>
    );
  }

  const bubble = (
    <View style={[ui.bubble, out ? ui.bubbleOut : null, kind === 'failed' || kind === 'held' ? ui.bubbleWarn : null, fillOn ? fillStyles.clip : null]}>
      {fillOn ? (
        <BubbleFill
          testID={`bubble-fill-${itemKey(item)}`}
          progress={pct}
          failed={kind === 'failed'}
          done={isDone}
        />
      ) : null}
      {content}
      {state !== null ? <Text style={kind === 'failed' ? ui.bubbleState : ui.hint}>{state}</Text> : null}
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
        {/* A text bubble keeps Copy in every state, including failed and
            waiting. Only a held item has no Copy. A text that the engine cut
            copies the whole text through onCopyWhole, because the page text is
            only the start of it. */}
        {item.type === 'text' && kind !== 'held' && onCopy && item.text !== null ? (
          <Quick
            label="Copy text"
            text="Copy"
            onPress={() => (item.textTruncated === true && onCopyWhole ? onCopyWhole(item) : onCopy(item.text ?? ''))}
          />
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
        {onStopRunning && fillOn && kind === 'file' && !isDone ? (
          <Quick label="Stop sending" text="Stop" testID={`thread-stop-${item.transferId}`} onPress={onStopRunning} />
        ) : null}
        {kind === 'waiting' && onStop ? (
          <Quick label={`Stop waiting to send ${name}`} text="Stop" onPress={() => onStop(item)} />
        ) : null}
      </View>
    </View>
  );
}

