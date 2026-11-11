import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import type { DaakEvent, DeviceInfo, ThreadItem, TransferSummary } from '@daak/core';
import { useEngine } from '../EngineContext';
import { Bubble, bubbleKind } from '../components/Bubble';
import { FolderBubble } from '../components/FolderBubble';
import { FolderSheet } from '../components/FolderSheet';
import { Sheet } from '../components/Sheet';
import { useToast } from '../components/Toast';
import { Btn, Empty, Note, ProgressBar, Status, deviceLabel, presenceOf, type DeviceNoun } from '../components/ds';
import type { InboxActions } from '../inbox-actions';
import { colors, control, ui } from '../theme';
import { humanBytes } from './quarantine-facts';
import { useTransferSpeed } from '../state/speed';
import { itemPercents } from '../state/progress';
import { EMPTY_THREAD, itemKey, mergeThread, prependOlder, type ThreadView } from './thread-merge';
import { folderPlaces, groupThread, savedLine, type FolderRow } from './thread-groups';

const PAGE = 50;
// More staged files than this fold into one summary chip. The composer must keep a fixed height.
const MAX_CHIPS = 3;
// How near the bottom (in points) still counts as "reading the newest items".
const NEAR_BOTTOM = 80;
// Events that can change this thread. transfer.item and transfer.done carry no
// peer id, so any of them refetches (spec 5.1 "Events").
const REFETCH_ON: ReadonlySet<DaakEvent['type']> = new Set<DaakEvent['type']>([
  'transfer.item',
  'transfer.done',
  'transfer.failed',
  'inbox.received',
  'outbox.queued',
  'device.state',
  'device.presence',
  'pairing.done',
  'pairing.revoked',
]);

const base = (p: string): string => p.split(/[\\/]/).pop() ?? p;
/** Splits a file name into the stem and the extension. A leading dot is not an extension. */
export const splitExt = (name: string): [string, string] => {
  const i = name.lastIndexOf('.');
  return i <= 0 ? [name, ''] : [name.slice(0, i), name.slice(i)];
};
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const errText = (e: unknown, fallback: string): string => (e instanceof Error ? e.message : fallback);

/**
 * The inline warning for a folder pick that failed. The pick rejects before a
 * path exists, so the text says "this folder", not the folder name.
 */
export function folderPickError(e: unknown): string {
  const m = e instanceof Error ? e.message : '';
  if (m.startsWith('NO_SPACE:')) {
    const need = humanBytes(Number(m.slice('NO_SPACE:'.length)));
    return `Not enough space to prepare this folder. Free ${need !== '' ? need : 'some space'} and try again.`;
  }
  if (m === 'EMPTY') return 'This folder has no files to send.';
  if (m === 'NOT_DOWNLOADED') {
    return 'This folder has files that are not downloaded yet. Open the Files app, download the folder, and try again.';
  }
  return "Couldn't prepare this folder. Check that every file in it is on this device and try again.";
}

/** One picked photo or video, by reference. The host makes the copy at send time. */
export type MediaRef = { token: string; name: string; size: number | null };

/** The photo picker of the host. `fits` tells if the whole selection fits the free space. */
export type MediaHost = {
  pick: () => Promise<MediaRef[]>;
  materialize: (token: string) => Promise<string>;
  fits: (refs: MediaRef[]) => Promise<boolean>;
  /**
   * Start a send in batches for a selection that does not fit. It resolves when the
   * first batch is copied. Without it the composer shows a toast for such a selection.
   */
  startLarge?: (peerId: string, refs: MediaRef[]) => Promise<void>;
};

/** The state of a large send. The fields are the same as the fields of the platform plan status. */
export type BatchRowStatus = {
  share: string;
  batch: number;
  of: number;
  paused: boolean;
  error?: 'NO_SPACE' | 'PLAN_LOST' | 'FAILED' | 'CANCELED';
  neededBytes?: number;
  /** The items after the current batch. */
  remaining: number;
  bytesDone: number;
  bytesTotal: number;
};

/** The host side of the batch row. The host owns the driver. */
export type BatchHost = {
  status: (peerId: string) => BatchRowStatus | null;
  retry: (peerId: string) => Promise<void> | void;
  stop: (peerId: string) => Promise<void> | void;
  /** Calls `cb` with a peer id when the plan of that peer changes. Returns the unsubscribe function. */
  subscribe: (cb: (peerId: string) => void) => () => void;
};

/** The body of a batch row that is paused. */
function batchBody(st: BatchRowStatus): string {
  if (st.error === 'NO_SPACE') {
    const need = st.neededBytes === undefined ? '' : humanBytes(st.neededBytes);
    return `Not enough space for this batch. Free ${need !== '' ? need : 'some space'} and tap Retry.`;
  }
  if (st.error === 'PLAN_LOST') return 'Some items can no longer be read. Pick them again.';
  if (st.error === 'CANCELED') return 'This batch was canceled.';
  return 'Daak could not send this batch.';
}

/** The inline warning for a large send that did not start. */
export function largeSendError(e: unknown): string {
  const m = e instanceof Error ? e.message : '';
  if (m === 'PLAN_BUSY') return 'A large send is already running for this device.';
  if (m === 'PLAN_TOO_LARGE') return 'Too many photos for one send. Pick fewer.';
  if (m.startsWith('NO_SPACE')) return 'Not enough space to prepare these photos. Free some space and try again.';
  return 'Daak could not prepare a file for sending.';
}

/** The inline warning for a photo selection that failed to pick or to prepare. Null shows nothing. */
export function mediaError(e: unknown): string | null {
  const m = e instanceof Error ? e.message : '';
  if (m === 'E_PICK_BUSY') return null;
  if (m === 'E_TOO_MANY') return 'Too many items. Pick fewer.';
  if (m === 'E_SOURCE_GONE') return 'Some items can no longer be read. Pick them again.';
  if (m.startsWith('NO_SPACE:')) {
    const need = humanBytes(Number(m.slice('NO_SPACE:'.length)));
    return `Not enough space to prepare these photos. Free ${need !== '' ? need : 'some space'} and try again.`;
  }
  if (m === 'NOT_DOWNLOADED') {
    return 'Some photos are not downloaded yet. Open the Photos app, download them, and try again.';
  }
  return 'Daak could not prepare a file for sending.';
}

/** The composer, inside a keyboard avoiding view only when the host asks. */
function ComposerWrap({ avoid, children }: { avoid: boolean; children: React.ReactNode }) {
  return avoid ? (
    <KeyboardAvoidingView testID="thread-keyboard-avoiding" behavior="padding">{children}</KeyboardAvoidingView>
  ) : (
    <>{children}</>
  );
}

// A failure that needs the user to act. A success is a toast, not a result.
type Result = { title: string; body: string; retry?: boolean } | null;

/**
 * The card of one running send. It is a component because the speed hook must
 * not run inside `active.map`. Every transfer in `active` is running.
 */
function ActiveSendCard({
  s,
  live,
  name,
  onStop,
  stop,
}: {
  s: TransferSummary;
  live: { done: number; total: number } | undefined;
  name: string;
  onStop: () => void;
  /** False when a bubble of this transfer shows the Stop control. One Stop shows. */
  stop: boolean;
}) {
  const done = live?.done ?? s.bytesDone;
  const total = live?.total ?? s.bytesTotal;
  const known = done > 0 && total > 0;
  const pct = known ? Math.floor((done / total) * 100) : 0;
  const { text: speed } = useTransferSpeed(s.transferId, done, total, true);
  return (
    <View style={[ui.card, { marginHorizontal: 12, marginBottom: 8 }]} testID={`thread-active-${s.transferId}`}>
      <Text style={ui.h3}>{`Sending to ${name}`}</Text>
      <Text style={ui.hint}>
        {[plural(s.itemCount, 'item', 'items'), humanBytes(total)].filter(Boolean).join(' · ')}
      </Text>
      <ProgressBar pct={pct} />
      <View style={ui.progMeta}>
        <Text style={[ui.hint, { flexShrink: 1 }]}>Sending over your Wi-Fi</Text>
        <View style={{ flexDirection: 'row', gap: 8, flexShrink: 1 }}>
          {speed === null ? null : (
            <Text style={ui.hint} numberOfLines={1} testID={`thread-speed-${s.transferId}`}>{speed}</Text>
          )}
          {known ? <Text style={ui.progN}>{pct + '%'}</Text> : null}
        </View>
      </View>
      {stop ? <Btn label="Stop sending" variant="danger" block testID={`thread-stop-${s.transferId}`} onPress={onStop} /> : null}
    </View>
  );
}

type PercentOf = (i: ThreadItem) => number | undefined;

/**
 * The percent of each item of one transfer. A finished transfer gives 100.
 * A cut item list gives undefined, so no fill shows.
 */
function percentsOf(items: ThreadItem[], bytesDone: number, finished: boolean): PercentOf {
  const map = itemPercents(items, bytesDone);
  if (map === null) return () => undefined;
  if (finished) return () => 100;
  return (i) => map.get(i.itemIndex);
}

/**
 * The speed of one transfer that has progress. It is a component, so the
 * speed hook runs once for each transfer and never in a loop. The children
 * get the speed text, or null during the warm-up.
 */
function TransferProgress({ transferId, done, total, running, children }: {
  transferId: string;
  done: number;
  total: number;
  running: boolean;
  children: (speedText: string | null) => React.ReactNode;
}) {
  const { text } = useTransferSpeed(transferId, done, total, running);
  return <>{children(text)}</>;
}

/**
 * The conversation with one paired device (design: `contact-detail`). It
 * replaces the Send, Inbox, and Transfers tabs.
 *
 * The device comes from `devices()`. `null` after the first load means the
 * engine does not list it: it was never paired, or it was removed. Then the
 * screen shows no history. `revoke_pairing` keeps the transfer rows, and a
 * queued row to a removed device never resolves.
 */
export function ThreadScreen({
  peerDeviceId,
  onBack,
  onPickFiles,
  actions,
  onOpenHeld,
  initialText = '',
  initialFiles = [],
  deviceNoun = 'phone',
  keyboardAvoiding = false,
  library,
  saveFolder,
  isMedia,
  onPickFolder,
  folderStats,
  discardPickedCopy,
  pickLabel = 'Add files',
  media,
  batch,
}: {
  peerDeviceId: string;
  onBack: () => void;
  onPickFiles?: () => Promise<string[]>;
  actions?: InboxActions;
  onOpenHeld?: (r: { transferId: string; itemIndex: number }) => void;
  initialText?: string;
  initialFiles?: string[];
  deviceNoun?: DeviceNoun;
  keyboardAvoiding?: boolean;
  /** The media library of this device. Absent when the host saves no media there. */
  library?: 'Photos' | 'Gallery';
  /** The save folder name, as Settings shows it. */
  saveFolder?: string;
  /** True for a file name with a media extension. The host owns the list. */
  isMedia?: (name: string) => boolean;
  /**
   * The phone folder picker. It copies the folder and resolves the path of the
   * copy, or null on Cancel. When it is set, the add button is a paperclip with
   * a menu. When it is not set (macOS), the add button opens `onPickFiles`.
   */
  onPickFolder?: () => Promise<string | null>;
  /** The file count and the size of a folder. Null for a path that is not a folder. */
  folderStats?: (path: string) => Promise<{ files: number; bytes: number } | null>;
  /** Deletes a copy that `onPickFolder` made. */
  discardPickedCopy?: (path: string) => Promise<void>;
  /** The label of the add button when there is no folder menu. */
  pickLabel?: string;
  /** The photo picker. When it is set, the add menu has an Add photos row. */
  media?: MediaHost;
  /** The state of a large send. When it is absent, the thread draws no batch row. */
  batch?: BatchHost;
}) {
  const engine = useEngine();
  const toast = useToast();
  const { height: windowHeight } = useWindowDimensions();
  const [device, setDevice] = useState<DeviceInfo | null | undefined>(undefined);
  const [thread, setThread] = useState<ThreadView>(EMPTY_THREAD);
  const [summaries, setSummaries] = useState<TransferSummary[]>([]);
  const [progress, setProgress] = useState<Record<string, { done: number; total: number }>>({});
  const [loadError, setLoadError] = useState('');
  const [paging, setPaging] = useState(false);
  const [text, setText] = useState(initialText);
  const [files, setFiles] = useState<string[]>(initialFiles);
  // The picked photos and videos. The copies are made at send time.
  const [mediaRefs, setMediaRefs] = useState<MediaRef[]>([]);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<Result>(null);
  const [stopFor, setStopFor] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [sizes, setSizes] = useState<Record<string, number | null>>({});
  const [folderKey, setFolderKey] = useState<string | null>(null);
  // The staged folders: path to file count and size.
  const [folders, setFolders] = useState<Record<string, { files: number; bytes: number }>>({});
  const [menuOpen, setMenuOpen] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  // The staged paths that are copies from `onPickFolder`. Only these are discarded.
  const copies = useRef<Set<string>>(new Set());
  // A new folder pick or a Cancel makes the earlier pick stale.
  const prepSeq = useRef(0);
  // The copies that a pending send reads. The unmount must not delete them.
  const inFlight = useRef<Set<string>>(new Set());

  const alive = useRef(true);

  // The batch row. The counter makes the screen read the status again.
  const [, setBatchTick] = useState(0);
  const [batchBusy, setBatchBusy] = useState(false);
  useEffect(() => {
    if (!batch) return undefined;
    return batch.subscribe((id) => { if (id === peerDeviceId) setBatchTick((n) => n + 1); });
  }, [batch, peerDeviceId]);
  const batchSt = batch ? batch.status(peerDeviceId) : null;
  const batchRunning = batchSt !== null && !batchSt.paused;
  const batchSpeed = useTransferSpeed(batchSt?.share ?? '', batchSt?.bytesDone ?? 0, batchSt?.bytesTotal ?? 0, batchRunning).text;
  const batchPct = batchSt !== null && batchSt.bytesTotal > 0
    ? Math.round(Math.max(0, Math.min(1, batchSt.bytesDone / batchSt.bytesTotal)) * 100)
    : null;
  const batchCall = async (fn: ((peerId: string) => Promise<void> | void) | undefined) => {
    if (!fn || batchBusy) return;
    setBatchBusy(true);
    try { await fn(peerDeviceId); } catch { /* The status shows the result. */ }
    if (alive.current) { setBatchBusy(false); setBatchTick((n) => n + 1); }
  };

  // A closed screen has no toast. The provider is gone and its timer would never clear.

  const say = (message: string) => { if (alive.current) toast.show(message); };
  const seq = useRef(0);
  const frame = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const scroller = useRef<ScrollView>(null);
  const stick = useRef(true); // the user is near the bottom
  const metrics = useRef({ offset: 0, content: 0, view: 0 });
  const anchor = useRef<{ content: number; offset: number } | null>(null);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [page, all, devs] = await Promise.all([
        engine.listThread(peerDeviceId, { limit: PAGE }),
        engine.listTransfers({ peerDeviceId, state: 'active' }),
        engine.devices(),
      ]);
      // A newer request started after this one. Its answer wins.
      if (!alive.current || mine !== seq.current) return;
      setThread((prev) => mergeThread(prev, page));
      setSummaries(all);
      // A device that the engine lists but has not paired is "not paired":
      // the engine refuses a send to it.
      const found = devs.find((d) => d.deviceId === peerDeviceId);
      setDevice(found !== undefined && found.paired === true ? found : null);
      setLoadError('');
    } catch (e) {
      if (alive.current && mine === seq.current) setLoadError(errText(e, 'the engine did not answer'));
    }
  }, [engine, peerDeviceId]);

  // One refetch for each animation frame, however many events arrive.
  const schedule = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      void load();
    });
  }, [load]);

  useEffect(() => {
    alive.current = true;
    void load();
    const off = engine.on((e) => {
      if (e.type === 'transfer.progress') {
        setProgress((p) => ({ ...p, [e.transferId]: { done: e.bytesDone, total: e.bytesTotal } }));
      } else if (REFETCH_ON.has(e.type)) {
        schedule();
      }
    });
    return () => {
      alive.current = false;
      off();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [engine, load, schedule]);

  // Best effort. A copy that stays goes at the next start (sweepPickedCopies).
  const discard = useCallback((path: string) => {
    if (!copies.current.delete(path) || !discardPickedCopy) return;
    discardPickedCopy(path).catch(() => {});
  }, [discardPickedCopy]);

  // The staged copies go with the composer.
  const discardRef = useRef(discard);
  discardRef.current = discard;
  useEffect(() => () => {
    for (const p of [...copies.current]) if (!inFlight.current.has(p)) discardRef.current(p);
  }, []);

  const loadOlder = async () => {
    if (thread.olderCursor === null || paging) return;
    setPaging(true);
    // Read the place before the await. Set the anchor only when the page adds
    // items, so an empty or duplicate-only page leaves no stale anchor.
    const place = { content: metrics.current.content, offset: metrics.current.offset };
    try {
      const page = await engine.listThread(peerDeviceId, { limit: PAGE, before: thread.olderCursor });
      if (alive.current) {
        const next = prependOlder(thread, page);
        if (next.items.length > thread.items.length) anchor.current = place;
        setThread((prev) => prependOlder(prev, page));
      }
    } catch (e) {
      if (alive.current) setLoadError(errText(e, 'the engine did not answer'));
    } finally {
      if (alive.current) setPaging(false);
    }
  };

  const onScroll = (ev: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = ev.nativeEvent;
    metrics.current = { offset: contentOffset.y, content: contentSize.height, view: layoutMeasurement.height };
    stick.current = contentSize.height - (contentOffset.y + layoutMeasurement.height) <= NEAR_BOTTOM;
    if (contentOffset.y <= 40) void loadOlder();
  };

  // A new page above keeps the reader's place. A new item below follows the
  // newest only when the reader was already at the bottom, so a resize or a
  // rotation while the reader scrolls up does not move the list.
  const onContentSize = (_w: number, h: number) => {
    const a = anchor.current;
    if (a !== null) {
      anchor.current = null;
      scroller.current?.scrollTo({ y: a.offset + (h - a.content), animated: false });
    } else if (stick.current) {
      scroller.current?.scrollToEnd({ animated: false });
    }
    metrics.current.content = h;
  };

  const name = device ? deviceLabel(device) : 'this device';
  const canSend = device != null && (files.length > 0 || mediaRefs.length > 0 || text.trim() !== '') && !sending && !preparing;

  // The review state ends when no file is left. Staging files again then shows the chip.
  useEffect(() => {
    if (files.length === 0) setReviewing(false);
  }, [files.length]);

  const fileSizes = actions?.fileSizes;
  // Sizes load while the review sheet is open, once for each path that has no size yet.
  // A rejected call records `null` for the paths, so the effect does not ask again.
  useEffect(() => {
    if (!reviewing || !fileSizes) return undefined;
    const missing = files.filter((p) => !(p in sizes) && !(p in folders));
    if (missing.length === 0) return undefined;
    let live = true;
    const record = (got: (number | null)[] | null) => {
      if (!live) return;
      setSizes((s) => {
        const next = { ...s };
        missing.forEach((p, i) => { next[p] = got?.[i] ?? null; });
        return next;
      });
    };
    fileSizes(missing).then(record, () => record(null));
    return () => { live = false; };
  }, [reviewing, files, fileSizes, sizes, folders]);

  const sizeOf = (p: string): number | null => folders[p]?.bytes ?? (typeof sizes[p] === 'number' ? (sizes[p] as number) : null);
  const allKnown = files.length > 0 && files.every((p) => sizeOf(p) !== null);
  const total = allKnown ? humanBytes(files.reduce((a, p) => a + (sizeOf(p) as number), 0)) : '';
  // A folder is not a file, so a list with a folder counts items (design `#cd-files-list`).
  const staged = Object.keys(folders).some((p) => files.includes(p))
    ? plural(files.length, 'item', 'items')
    : plural(files.length, 'file', 'files');

  // Marks each path that is a folder. A path that is not a folder gets no entry.
  const measure = async (paths: string[]) => {
    if (!folderStats) return;
    const got = await Promise.all(paths.map((p) => folderStats(p).catch(() => null)));
    if (!alive.current) return;
    const found: Record<string, { files: number; bytes: number }> = {};
    const empty: string[] = [];
    paths.forEach((p, i) => {
      const g = got[i];
      if (g && g.files === 0) empty.push(p);
      else if (g) found[p] = g;
    });
    if (Object.keys(found).length > 0) setFolders((f) => ({ ...f, ...found }));
    // The engine skips or refuses an empty folder. Refuse it here, with its name.
    if (empty.length > 0) {
      setFiles((f) => f.filter((x) => !empty.includes(x)));
      setPickError(`"${base(empty[empty.length - 1])}" has no files to send.`);
    }
  };

  const remove = (p: string) => {
    setFiles((f) => f.filter((x) => x !== p));
    setFolders((f) => {
      if (!(p in f)) return f;
      const next = { ...f };
      delete next[p];
      return next;
    });
    discard(p);
  };

  const pick = () => {
    setMenuOpen(false);
    if (!onPickFiles) return;
    setPickError(null);
    // A picker that rejects leaves the composer usable. Both native pickers
    // resolve an empty list on Cancel.
    // The picker is modal, so `files` cannot change while it is open. The toast
    // says the total count, as the design does ("{n} file(s) ready").
    void onPickFiles()
      .then((picked) => {
        const next = [...files, ...picked.filter((p) => !files.includes(p))];
        if (next.length === files.length) return;
        setFiles(next);
        say(`${plural(next.length, 'file', 'files')} ready`);
        // The macOS panel can also pick a folder. A phone file picker cannot,
        // so a phone makes no bridge call for each file.
        if (!onPickFolder) void measure(picked.filter((p) => !files.includes(p)));
      })
      .catch(() => {});
  };

  const pickMedia = () => {
    setMenuOpen(false);
    if (!media) return;
    setPickError(null);
    void media.pick()
      .then((picked) => {
        setMediaRefs((cur) => {
          const next = [...cur, ...picked.filter((r) => !cur.some((c) => c.token === r.token))];
          return next.length === cur.length ? cur : next;
        });
      })
      .catch((e) => { if (alive.current) setPickError(mediaError(e)); });
  };

  // The phone copies the folder first (design F4). Send waits for the copy.
  const pickFolder = () => {
    setMenuOpen(false);
    if (!onPickFolder || preparing) return;
    const mine = ++prepSeq.current;
    const stale = () => !alive.current || mine !== prepSeq.current;
    setPickError(null);
    setPreparing(true);
    void (async () => {
      try {
        const path = await onPickFolder();
        if (path === null) return;
        copies.current.add(path);
        const stats = folderStats ? await folderStats(path).catch(() => null) : null;
        if (stale()) {
          discard(path);
          return;
        }
        // A copy that cannot be measured is not a usable folder. Plain-file
        // staging would send a directory to `fileSizes`.
        if (folderStats && !stats) {
          discard(path);
          throw new Error('E_COPY');
        }
        if (stats) setFolders((f) => ({ ...f, [path]: stats }));
        setFiles((f) => (f.includes(path) ? f : [...f, path]));
        say('Folder staged');
      } catch (e) {
        if (!stale()) setPickError(folderPickError(e));
      } finally {
        if (!stale()) setPreparing(false);
      }
    })();
  };

  // The copy cannot stop. The composer drops it and discards it when it arrives.
  const cancelPrepare = () => {
    prepSeq.current += 1;
    setPreparing(false);
  };

  // A second press in the same tick must not start a second send.
  const sendingRef = useRef(false);

  const submit = async () => {
    if (device == null || !canSend || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setResult(null);
    setPickError(null);
    const note = text.trim();
    // Take the staged photos now. A pick or a removal later does not change this send.
    const sentRefs = mediaRefs;
    const sentTokens = new Set(sentRefs.map((r) => r.token));
    // The copies of the picked photos. One send reads them with the plain files.
    const made: string[] = [];
    const dropMade = () => made.forEach(discard);
    let sendFiles = files;
    // True when the photos go to startLarge after the plain files and the note.
    let large = false;
    try {
      if (sentRefs.length > 0 && media) {
        let ok = false;
        let fitError: unknown = null;
        try { ok = await media.fits(sentRefs); } catch (e) { fitError = e ?? new Error('fits'); }
        if (fitError === null && !ok && media.startLarge) {
          large = true;
        } else if (fitError !== null || !ok) {
          say(fitError !== null ? 'Daak could not prepare a file for sending.' : 'Large selection is not supported yet');
          if (alive.current && fitError !== null) setPickError('Daak could not prepare a file for sending.');
          return;
        }
        if (!large) try {
          for (const r of sentRefs) {
            const path = await media.materialize(r.token);
            copies.current.add(path);
            made.push(path);
            if (!alive.current) {
              dropMade();
              return;
            }
          }
        } catch (e) {
          dropMade();
          if (alive.current) setPickError(mediaError(e) ?? 'Daak could not prepare a file for sending.');
          return;
        }
        if (!large) sendFiles = [...files, ...made];
      }
      // The engine reports queued: true for every send. The words come from the
      // presence of the peer at the time of the send.
      const waiting = presenceOf(device).rank >= 2;
      try {
        // Files first, then the note. send() takes one kind in each call. Each
        // part leaves the composer as soon as the engine accepts it, so a failed
        // note does not send the files again.
        if (sendFiles.length > 0) {
          const sent = sendFiles.filter((p) => copies.current.has(p));
          sent.forEach((p) => inFlight.current.add(p));
          try {
            await engine.send({ peerDeviceId, files: sendFiles });
          } finally {
            sent.forEach((p) => inFlight.current.delete(p));
            // A closed screen cannot show the chip again, so its copies go now.
            if (!alive.current) sent.forEach(discard);
          }
          // The engine staged the files before it resolved, so the copies can go.
          sendFiles.forEach(discard);
          setFiles([]);
          setMediaRefs((cur) => cur.filter((r) => !sentTokens.has(r.token)));
          setSizes({});
          setFolders({});
        }
        if (note !== '') {
          await engine.send({ peerDeviceId, text: note });
          setText('');
        }
        if (large && media?.startLarge) {
          try {
            await media.startLarge(peerDeviceId, sentRefs);
          } catch (e) {
            if (alive.current) setPickError(largeSendError(e));
            return;
          }
          setMediaRefs((cur) => cur.filter((r) => !sentTokens.has(r.token)));
        }
        say(waiting ? `Will send when ${name} is back` : `Sent to ${name}`);
        stick.current = true;
      } catch (e) {
        // A failed send keeps the staged photos. The next Send makes new copies.
        dropMade();
        setResult({
          title: 'That send did not go through',
          body: errText(e, 'The engine refused the send.'),
          retry: true,
        });
      } finally {
        schedule();
      }
      } finally {
      sendingRef.current = false;
      if (alive.current) setSending(false);
    }
  };

  const stop = async () => {
    const id = stopFor;
    setStopFor(null);
    if (id === null) return;
    try {
      await engine.cancel(id);
      say('Sending stopped');
    } catch (e) {
      setResult({ title: 'Sending did not stop', body: errText(e, 'The engine refused.') });
    }
    schedule();
  };

  // A queued bubble has sent nothing yet. Stop cancels at once (design).
  const stopWaiting = async (transferId: string) => {
    try {
      await engine.cancel(transferId);
      say('Stopped');
    } catch (e) {
      setResult({ title: 'Sending did not stop', body: errText(e, 'The engine refused.') });
    }
    schedule();
  };

  const retry = async (transferId: string) => {
    try {
      await engine.retry(transferId);
      // The task order: the app shows the design success word after a Retry.
      say(`Sent to ${name}`);
    } catch (e) {
      setResult({ title: 'Try again did not work', body: errText(e, 'The engine refused.') });
    }
    schedule();
  };

  const header = (
    <View style={ui.appbar}>
      <Pressable
        testID="thread-back"
        accessibilityRole="button"
        accessibilityLabel="Go back"
        accessibilityHint="Back to the device list"
        onPress={onBack}
        style={ui.iconbtn}
      >
        <Text style={ui.appbarGlyph}>‹</Text>
      </Pressable>
      <View style={ui.fill}>
        <Text style={ui.h3} numberOfLines={1} accessibilityRole="header">{device ? name : 'Conversation'}</Text>
        {device ? <Status tone={presenceOf(device).tone} label={presenceOf(device).label} /> : null}
      </View>
    </View>
  );

  if (device === undefined && loadError === '') {
    return <View style={ui.screen}>{header}</View>;
  }

  if (device === null) {
    return (
      <View style={ui.screen}>
        {header}
        <View style={ui.pad}>
          <View testID="thread-not-paired">
            <Empty
              title="Not paired any more"
              body="This device is not in your list. Pair it again to send to it."
              action={<Btn label="Back to devices" onPress={onBack} testID="thread-not-paired-back" />}
            />
          </View>
        </View>
      </View>
    );
  }

  const removeChip = (p: string) => (
    <Pressable
      key={p}
      onPress={() => remove(p)}
      accessibilityRole="button"
      accessibilityLabel={`Remove ${base(p)}`}
      testID={`remove-${base(p)}`}
      style={({ pressed }) => [ui.chip, pressed ? ui.pressed : null]}
    >
      <Text style={ui.chipLabel} numberOfLines={1}>
        {folders[p] ? `${base(p)} · ${plural(folders[p].files, 'file', 'files')}` : base(p)}
      </Text>
      <Text style={ui.chipLabelOn}>×</Text>
    </Pressable>
  );

  const active = summaries.filter((s) => s.direction === 'out' && s.state === 'active');

  // The thread item verbs. A bubble and a row of the folder sheet share them.
  const preview = actions?.open
    ? (i: ThreadItem) => {
        const open = actions.open;
        // Ruling: a Preview that no app can open is a toast.
        const noApp = () => say('This device cannot open files.');
        if (open && i.destPath !== null) {
          void open(i.destPath).then((ok) => { if (!ok) noApp(); }, noApp);
        }
      }
    : undefined;
  const share = actions?.share
    ? (i: ThreadItem) => { if (i.destPath !== null) actions.share?.([i.destPath]); }
    : undefined;
  const canShare = (i: ThreadItem): boolean => i.destPath === null || (actions?.canShare?.(i.destPath) ?? true);
  const openHeld = onOpenHeld ? (i: ThreadItem) => onOpenHeld({ transferId: i.transferId, itemIndex: i.itemIndex }) : undefined;

  const rows = groupThread(thread.items);
  // The host has no library (macOS, or Android 9 and older), so no media went there.
  const placesOf = (r: FolderRow) =>
    folderPlaces(r.children, library === undefined || isMedia === undefined ? 0 : r.children.filter((c) => isMedia(c.name ?? '')).length);
  const openFolder = folderKey === null ? undefined : rows.find((r): r is FolderRow => r.kind === 'folder' && r.key === folderKey);
  const offline = device != null && device.presence === 'offline';

  // The progress of each transfer on the page. The `transfer.progress` event
  // has no item index, so the percent of a file comes from the bytes of the
  // whole transfer. The engine writes the `done` item rows only at the end, so
  // the item state does not tell which file is done.
  const byTransfer = new Map<string, ThreadItem[]>();
  for (const it of thread.items) {
    const list = byTransfer.get(it.transferId);
    if (list) list.push(it);
    else byTransfer.set(it.transferId, [it]);
  }
  const rowTid = (r: (typeof rows)[number]): string => (r.kind === 'folder' ? r.transferId : r.item.transferId);
  const rowKey = (r: (typeof rows)[number]): string => (r.kind === 'folder' ? `folder:${r.key}` : itemKey(r.item));
  const isRunning = (tid: string): boolean => byTransfer.get(tid)?.[0]?.transferState === 'active';
  // A transfer that ran in this session keeps its fill after it ends, so the
  // fill fades out. A transfer from an earlier session has no fill.
  const tracked = (tid: string): boolean => isRunning(tid) || progress[tid] !== undefined;
  // One pass for each tracked transfer on each render. A row reads this map.
  // `filling` is the file that fills now: the first file, in item order, below 100.
  type Live = { percentOf: PercentOf; filling: string | null; bytes: { done: number; total: number } };
  const live = new Map<string, Live>();
  for (const [tid, items] of byTransfer) {
    if (!tracked(tid)) continue;
    const s = summaries.find((x) => x.transferId === tid);
    const bytes = { done: progress[tid]?.done ?? s?.bytesDone ?? 0, total: progress[tid]?.total ?? s?.bytesTotal ?? 0 };
    const percentOf = percentsOf(items, bytes.done, items[0].transferState === 'done');
    const f = isRunning(tid)
      ? items.filter((i) => i.type === 'file').sort((a, b) => a.itemIndex - b.itemIndex)
        .find((i) => { const p = percentOf(i); return p !== undefined && p < 100; })
      : undefined;
    live.set(tid, { percentOf, filling: f ? itemKey(f) : null, bytes });
  }
  // One Stop for each running send: on the first row that can show it.
  const stopRow = new Map<string, string>();
  for (const r of rows) {
    const tid = rowTid(r);
    if (stopRow.has(tid) || !isRunning(tid)) continue;
    const can = r.kind === 'folder'
      ? r.direction === 'out' && r.state === 'sending'
      : r.item.direction === 'out' && bubbleKind(r.item) === 'file';
    if (can) stopRow.set(tid, rowKey(r));
  }
  // Consecutive rows of one transfer share one speed hook.
  const runs: { tid: string; rows: { row: (typeof rows)[number]; idx: number }[] }[] = [];
  rows.forEach((row, idx) => {
    const last = runs[runs.length - 1];
    if (last && last.tid === rowTid(row)) last.rows.push({ row, idx });
    else runs.push({ tid: rowTid(row), rows: [{ row, idx }] });
  });

  const renderRow = (row: (typeof rows)[number], idx: number, speedText: string | null) => {
    const tid = rowTid(row);
    const lv = live.get(tid);
    const pct = lv?.percentOf;
    const onStopRunning = stopRow.get(tid) === rowKey(row) ? () => setStopFor(tid) : undefined;
    if (row.kind === 'folder') {
      // The folder shows the speed while one of its files fills.
      const folderMeta = speedText !== null && row.children.some((c) => itemKey(c) === lv?.filling) ? speedText : undefined;
      return (
        <FolderBubble
          key={`folder:${row.key}`}
          row={row}
          savedLine={savedLine(placesOf(row), library, saveFolder)}
          onOpen={(r) => { Keyboard.dismiss(); setFolderKey(r.key); }}
          percentOf={pct}
          onStopRunning={onStopRunning}
          meta={folderMeta}
        />
      );
    }
    const it = row.item;
    const next = rows[idx + 1];
    const p = pct?.(it);
    // The meta line shows only while the transfer runs. The speed shows only
    // on the file that fills now, after the warm-up of the speed hook.
    const meta = p === undefined || !isRunning(tid) || bubbleKind(it) !== 'file' ? undefined
      : speedText !== null && lv?.filling === itemKey(it) ? `${p}% · ${speedText}`
      : `${p}%`;
    return (
    <React.Fragment key={itemKey(it)}>
    <Bubble
      item={it}
      progress={p}
      meta={meta}
      onStopRunning={onStopRunning}
      onCopy={
        actions?.copy
          ? (t) => {
              actions.copy?.(t);
              toast.show('Copied');
            }
          : undefined
      }
      onCopyWhole={
        actions?.copy
          ? (i) => {
              // The page cut this text. Copy the whole text, or copy nothing.
              void engine.getItemText(i.transferId, i.itemIndex).then(
                (whole) => {
                  actions.copy?.(whole);
                  say('Copied');
                },
                () => say('Could not copy the whole text.'),
              );
            }
          : undefined
      }
      onPreview={preview}
      onShare={share && canShare(it) ? share : undefined}
      onOpenHeld={openHeld}
      onRetry={(i) => void retry(i.transferId)}
      onStop={(i) => void stopWaiting(i.transferId)}
    />
    {/* The engine cut the item list of this send. Say so once, after its
        last kept item. A folder sheet says it for its own files. */}
    {it.truncated === true && (next?.kind === 'folder' ? next.transferId : next?.item.transferId) !== it.transferId ? (
      <Text style={ui.hint}>Some items of this send are not shown.</Text>
    ) : null}
    </React.Fragment>
    );
  };

  return (
    <View style={ui.screen}>
      {header}
      <ScrollView
        ref={scroller}
        contentContainerStyle={ui.threadList}
        onScroll={onScroll}
        scrollEventThrottle={64}
        onContentSizeChange={onContentSize}
        keyboardShouldPersistTaps="handled"
      >
        {loadError !== '' ? (
          <View style={ui.stackSm}>
            <Note tone="err" title="The conversation did not load" body={loadError} testID="thread-error" />
            <Btn label="Try again" variant="quiet" onPress={() => void load()} testID="thread-reload" />
          </View>
        ) : null}
        {thread.olderCursor !== null ? (
          <Btn label="Show earlier" variant="ghost" disabled={paging} onPress={() => void loadOlder()} testID="thread-load-older" />
        ) : null}
        {device !== undefined && thread.items.length === 0 && loadError === '' ? (
          <Empty title="Nothing here yet" body="Send the first file or note with the buttons below. It travels straight to this device over your Wi-Fi." />
        ) : null}
        {runs.map((run) => {
          const b = live.get(run.tid)?.bytes;
          if (!b) return run.rows.map(({ row, idx }) => renderRow(row, idx, null));
          return (
            <TransferProgress
              key={`run:${rowKey(run.rows[0].row)}`}
              transferId={run.tid}
              done={b.done}
              total={b.total}
              running={isRunning(run.tid)}
            >
              {(speedText) => run.rows.map(({ row, idx }) => renderRow(row, idx, speedText))}
            </TransferProgress>
          );
        })}
        {batchSt === null ? null : batchSt.paused ? (
          <View style={ui.stackSm}>
            <Note
              tone="warn"
              title={`Batch ${batchSt.batch} did not send`}
              body={batchBody(batchSt)}
              testID="batch-row"
              accessibilityLabel={`Batch ${batchSt.batch} did not send. ${batchBody(batchSt)}`}
            />
            <View style={ui.row}>
              <Btn label="Retry" variant="quiet" disabled={batchBusy} onPress={() => void batchCall(batch?.retry)} testID="batch-retry" />
              <Btn label="Stop" variant="danger" disabled={batchBusy} onPress={() => void batchCall(batch?.stop)} testID="batch-stop" />
            </View>
          </View>
        ) : (
          <View
            style={[ui.card, { marginBottom: 8 }]}
            testID="batch-row"
            accessibilityLabel={batchSt.remaining > 0 ? `${batchSt.remaining} more waiting - batch ${batchSt.batch} of ${batchSt.of}` : `Sending batch ${batchSt.batch} of ${batchSt.of}`}
          >
            <Text style={ui.h3}>
              {batchSt.remaining > 0 ? `${batchSt.remaining} more waiting - batch ${batchSt.batch} of ${batchSt.of}` : `Sending batch ${batchSt.batch} of ${batchSt.of}`}
            </Text>
            {batchPct === null ? null : (
              <View
                style={ui.barTrack}
                testID="batch-bar"
                accessibilityRole="progressbar"
                accessibilityValue={{ min: 0, max: 100, now: batchPct }}
              >
                <View style={[ui.barFill, { width: `${batchPct}%` }]} />
              </View>
            )}
            {batchSpeed === null ? null : <Text style={ui.hint} numberOfLines={1}>{batchSpeed}</Text>}
          </View>
        )}
      </ScrollView>

      {active.map((s) => (
        <ActiveSendCard
          key={s.transferId}
          s={s}
          live={progress[s.transferId]}
          name={name}
          onStop={() => setStopFor(s.transferId)}
          stop={!stopRow.has(s.transferId)}
        />
      ))}

      {result ? (
        <View style={{ paddingHorizontal: 12, gap: 8 }}>
          <Note tone="err" title={result.title} body={result.body} testID="thread-result" />
          {result.retry ? <Btn label="Try again" variant="quiet" onPress={() => void submit()} testID="thread-retry-send" /> : null}
        </View>
      ) : null}
      {offline && result === null ? (
        <View style={{ paddingHorizontal: 12 }}>
          {/* Design #cd-offline-note. The peer is Offline, not Away. */}
          <Note
            icon={<WifiOffIcon />}
            body={`${name} is not on this Wi-Fi. What you send waits here and goes when they are back.`}
          />
        </View>
      ) : null}

      <ComposerWrap avoid={keyboardAvoiding}>
      <View style={ui.composer}>
        {files.length > 0 || mediaRefs.length > 0 || preparing ? (
          <View style={ui.stackSm}>
            <View style={[ui.row, { flexWrap: 'wrap' }]}>
              {files.length > MAX_CHIPS ? (
                <Pressable
                  onPress={() => { Keyboard.dismiss(); setReviewing(true); }}
                  accessibilityRole="button"
                  accessibilityLabel={`Review ${staged}`}
                  testID="files-review"
                  style={({ pressed }) => [ui.chip, pressed ? ui.pressed : null]}
                >
                  <Text style={ui.chipLabel}>{`${staged} · Review`}</Text>
                </Pressable>
              ) : (
                files.map((p) => removeChip(p))
              )}
              {mediaRefs.map((r) => (
                <Pressable
                  key={r.token}
                  onPress={() => setMediaRefs((cur) => cur.filter((x) => x.token !== r.token))}
                  disabled={sending}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${r.name}`}
                  testID={`remove-media-${r.token}`}
                  style={({ pressed }) => [ui.chip, pressed ? ui.pressed : null]}
                >
                  <Text style={ui.chipLabel} numberOfLines={1}>{r.name}</Text>
                  <Text style={ui.chipLabelOn}>×</Text>
                </Pressable>
              ))}
              {preparing ? (
                <View style={ui.chip} testID="prepare-chip">
                  <Text style={ui.chipLabel}>Preparing…</Text>
                </View>
              ) : null}
              {preparing ? <Btn label="Cancel" variant="ghost" size="sm" onPress={cancelPrepare} testID="prepare-cancel" /> : null}
            </View>
          </View>
        ) : null}
        {pickError !== null ? <Note tone="warn" body={pickError} testID="pick-error" accessibilityLabel={pickError} /> : null}
        <View style={ui.composerRow} testID="composer-row">
          {onPickFiles && onPickFolder ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add files or folders"
              onPress={() => { Keyboard.dismiss(); setMenuOpen(true); }}
              disabled={sending}
              testID="pick-files"
              style={({ pressed }) => [ui.btn, ui.btnQuiet, ui.addIcon, pressed ? ui.pressed : null]}
            >
              <PaperclipIcon />
            </Pressable>
          ) : onPickFiles ? (
            <Btn label={pickLabel} variant="quiet" disabled={sending} onPress={pick} testID="pick-files" />
          ) : null}
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Or type a note"
            placeholderTextColor={colors.meta}
            accessibilityLabel="Type a note"
            multiline
            style={[ui.input, ui.fill, { maxHeight: 120, minHeight: control.minHeight, textAlignVertical: 'top' }]}
          />
          <Btn label="Send" variant="primary" disabled={!canSend} onPress={() => void submit()} testID="send" />
        </View>
      </View>
      </ComposerWrap>

      {/* Design #cd-add-menu: two rows. The note field keeps its width. */}
      <Sheet open={menuOpen} title="Add files or folders" onClose={() => setMenuOpen(false)}>
        <View style={ui.stackSm}>
          <Btn label="Files" variant="quiet" block onPress={pick} testID="pick-menu-files" />
          <Btn label="Folder" variant="quiet" block onPress={pickFolder} testID="pick-menu-folder" />
          {media ? <Btn label="Add photos" variant="quiet" block onPress={pickMedia} testID="pick-menu-photos" /> : null}
        </View>
      </Sheet>

      <Sheet
        open={reviewing && files.length > 0}
        title={staged + (total !== '' ? ` · ${total}` : '')}
        onClose={() => setReviewing(false)}
        actions={<Btn label="Done" variant="quiet" block onPress={() => setReviewing(false)} testID="files-review-done" />}
      >
        <ScrollView style={{ maxHeight: Math.min(320, windowHeight * 0.4) }} keyboardShouldPersistTaps="handled">
          <View style={ui.list}>
            {files.map((p) => (
              <View key={p} style={ui.listRow}>
                {folders[p] ? (
                  // A folder is one row. The sheet does not list its files.
                  <View style={ui.fill}>
                    <Text style={ui.rowTitle} numberOfLines={1} ellipsizeMode="middle">{base(p)}</Text>
                    <Text style={ui.rowSub}>
                      {[plural(folders[p].files, 'file', 'files'), humanBytes(folders[p].bytes)].filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                ) : (
                <View style={ui.fill}>
                  <Text style={ui.rowTitle} numberOfLines={1} ellipsizeMode="middle">{splitExt(base(p))[0]}
                    <Text style={{ color: colors.meta }}>{splitExt(base(p))[1]}</Text>
                  </Text>
                  {typeof sizes[p] === 'number' && humanBytes(sizes[p] as number) !== '' ? (
                    <Text style={ui.rowSub}>{humanBytes(sizes[p] as number)}</Text>
                  ) : null}
                </View>
                )}
                <Btn
                  label="Remove"
                  accessibilityLabel={`Remove ${base(p)}`}
                  size="sm"
                  variant="quiet"
                  testID={`review-remove-${base(p)}`}
                  onPress={() => remove(p)}
                />
              </View>
            ))}
          </View>
        </ScrollView>
      </Sheet>

      {openFolder !== undefined ? (
        <FolderSheet
          row={openFolder}
          open
          onClose={() => setFolderKey(null)}
          onRetry={(i) => void retry(i.transferId)}
          onStop={(r) => {
            // One sheet shows at a time. The confirm sheet replaces the folder sheet.
            setFolderKey(null);
            setStopFor(r.transferId);
          }}
          onPreview={preview}
          onShare={share}
          canShare={canShare}
          onOpenHeld={openHeld}
          places={placesOf(openFolder)}
          percentOf={live.get(openFolder.transferId)?.percentOf}
          library={library}
          saveFolder={saveFolder}
        />
      ) : null}

      <Sheet
        open={stopFor !== null}
        title="Stop sending?"
        onClose={() => setStopFor(null)}
        actions={
          <>
            <Btn label="Stop sending" variant="danger" block onPress={() => void stop()} testID="confirm-stop" />
            <Btn label="Keep sending" variant="ghost" block onPress={() => setStopFor(null)} testID="keep-sending" />
          </>
        }
      >
        <Text style={ui.lead}>
          {`Nothing has reached ${name} yet. If you stop now, the items stay on this ${deviceNoun}.`}
        </Text>
      </Sheet>
    </View>
  );
}

// The design `#cd-add` icon: a paperclip. react-native-svg is not a
// dependency, so it is a long loop with a short open loop inside, turned
// 45 degrees. The stroke is the design 1.75 at 20 points.
const CLIP_STROKE = 1.75;

/** The paperclip of the add button on a phone. */
function PaperclipIcon({ color = colors.fg }: { color?: string }) {
  return (
    <View testID="paperclip-icon" style={{ width: 20, height: 20, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '45deg' }] }}>
      <View
        style={{
          width: 8,
          height: 19,
          borderWidth: CLIP_STROKE,
          borderColor: color,
          borderRadius: 4,
          alignItems: 'center',
          paddingTop: 4,
        }}
      >
        <View
          style={{
            width: 3.5,
            height: 9,
            borderWidth: CLIP_STROKE,
            borderTopWidth: 0,
            borderColor: color,
            borderBottomLeftRadius: 2,
            borderBottomRightRadius: 2,
          }}
        />
      </View>
    </View>
  );
}

// The design `#cd-offline-note` icon: a wifi-off mark. react-native-svg is not
// a dependency, so three arcs, a dot, and a slash are View elements at the
// design geometry (viewBox 24). A number below is a design unit times K.
const WIFI_ICON = 20;
const WIFI_K = WIFI_ICON / 24;
const WIFI_STROKE = 1.75 * WIFI_K;
const WIFI_OX = 12 * WIFI_K; // The arcs spray from this point.
const WIFI_OY = 20 * WIFI_K;
const WIFI_RADII = [15, 10, 5]; // The three arc radii of the design.
const WIFI_SLASH = 20 * Math.SQRT2 * WIFI_K; // The slash runs 2,2 to 22,22.

/** One wifi arc. A quarter ring, turned to sit symmetric about the vertical. */
function WifiArc({ r, color }: { r: number; color: string }) {
  const d = r * WIFI_K;
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: WIFI_OX,
        top: WIFI_OY - d,
        width: d,
        height: d,
        borderTopWidth: WIFI_STROKE,
        borderRightWidth: WIFI_STROKE,
        borderTopColor: color,
        borderRightColor: color,
        borderTopRightRadius: d,
        transformOrigin: 'bottom left',
        transform: [{ rotate: '-45deg' }],
      }}
    />
  );
}

/**
 * The offline note icon of the design: a wifi mark with a slash. The stroke
 * uses the muted tone. The icon replaces the note dot.
 */
function WifiOffIcon({ color = colors.muted }: { color?: string }) {
  return (
    <View style={{ width: WIFI_ICON, height: WIFI_ICON }} testID="wifi-off-icon">
      {WIFI_RADII.map((r) => (
        <WifiArc key={r} r={r} color={color} />
      ))}
      <View
        style={{
          position: 'absolute',
          left: WIFI_OX - WIFI_STROKE / 2,
          top: WIFI_OY - WIFI_STROKE / 2,
          width: WIFI_STROKE,
          height: WIFI_STROKE,
          borderRadius: WIFI_STROKE / 2,
          backgroundColor: color,
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: 12 * WIFI_K - WIFI_SLASH / 2,
          top: 12 * WIFI_K - WIFI_STROKE / 2,
          width: WIFI_SLASH,
          height: WIFI_STROKE,
          borderRadius: WIFI_STROKE / 2,
          backgroundColor: color,
          transform: [{ rotate: '45deg' }],
        }}
      />
    </View>
  );
}

