import type { InboxEntry } from '@daak/core';
import { notifyReceived } from '@daak/platform';
import { safeName } from '@daak/rn-notify/js/actions';

// A large selection is sent as several batches. Each batch is one transfer. This
// module shows ONE notification for the whole share. The notification is silent
// while batches arrive. It plays the sound once: at the end, or when the
// 3-minute timer fires first. A batch can be up to 4 GiB, so a gap above
// 3 minutes is normal. The timer does not end the share: the count goes on.
//
// The sender is not trusted. `m` comes from the first batch only. The count
// comes from the files that this device saved, never from the tag.

const TIMEOUT_MS = 3 * 60_000;
const SOUND_GAP_MS = 10_000;
const MAX_OPEN_SHARES = 32;
const MAX_OPEN_PER_PEER = 8;
// A batch that comes again after its share closed (a lost ACK) is ignored.
const MAX_CLOSED = 32;
// The notification payload goes into 3 Android PendingIntent extras (Binder).
// A share of thousands of files would overflow it. The count line is exact.
// The Share button acts on at most this many files.
const MAX_PATHS = 200;

interface Text {
  title: string;
  body: string;
}
interface Extra {
  /** The folder text of `receivedText`. Used for an entry without a tag. */
  text?: Text | null;
  /** The name of the sender, for the line of a batched share. */
  deviceName?: string;
}
interface Open {
  m: number;
  ks: Set<number>;
  count: number;
  paths: string[];
  peer: string;
  entry: InboxEntry;
  deviceName?: string;
  /** True after the sound played. Then no new timer starts. */
  sounded: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

// A Map keeps the order of insertion, so the first key is the oldest share.
const open = new Map<string, Open>();
const lastSound = new Map<string, number>();
// A Set keeps the order of insertion, so the first value is the oldest id.
const closed = new Set<string>();

export function resetShareNotifierForTests(): void {
  for (const s of open.values()) clearTimeout(s.timer);
  open.clear();
  lastSound.clear();
  closed.clear();
}

function parseTag(entry: InboxEntry): { k: number; m: number } | null {
  const match = /^(\d{1,4})\/(\d{1,4})$/.exec(entry.batch ?? '');
  if (!match || !/^[0-9a-f]{32}$/.test(entry.share ?? '')) return null;
  const k = Number(match[1]);
  const m = Number(match[2]);
  return m > 1 && k >= 1 && k <= m ? { k, m } : null;
}

function line(count: number, deviceName?: string): Text {
  const name = safeName(deviceName ?? '') || 'another device';
  return { title: 'Daak', body: `Received ${count} ${count === 1 ? 'file' : 'files'} from ${name}` };
}

async function postShare(key: string, s: Open, wantSound: boolean, now: number): Promise<void> {
  let silent = !wantSound;
  if (wantSound) {
    const last = lastSound.get(s.peer);
    if (last !== undefined && now - last < SOUND_GAP_MS) silent = true;
    else {
      for (const [peer, t] of lastSound) if (now - t >= SOUND_GAP_MS) lastSound.delete(peer);
      lastSound.set(s.peer, now);
    }
  }
  try {
    await notifyReceived({ ...s.entry, savedPaths: s.paths }, line(s.count, s.deviceName), { key, silent, thread: key });
  } catch {
    // The facade logs a failed post. A lost banner must not break the pipeline.
  }
}

export async function onReceived(
  entry: InboxEntry,
  savedCount: number,
  now: number,
  extra: Extra = {},
): Promise<void> {
  const tag = parseTag(entry);
  if (!tag) {
    try {
      await notifyReceived(entry, extra.text);
    } catch {
      // See postShare.
    }
    return;
  }
  const id = `${entry.peerDeviceId}:${entry.share}`;
  const key = `share:${id}`;
  if (closed.has(id)) return;
  let s = open.get(id);
  if (!s) {
    const evict = (id: string) => {
      clearTimeout(open.get(id)?.timer);
      open.delete(id);
    };
    // A peer cannot push out the open shares of another peer: its own oldest
    // share goes first.
    let mine = 0;
    for (const x of open.values()) if (x.peer === entry.peerDeviceId) mine += 1;
    if (mine >= MAX_OPEN_PER_PEER) {
      for (const [k, x] of open) {
        if (x.peer === entry.peerDeviceId) {
          evict(k);
          break;
        }
      }
    }
    if (open.size >= MAX_OPEN_SHARES) evict(open.keys().next().value as string);
    s = {
      m: tag.m,
      ks: new Set(),
      count: 0,
      paths: [],
      peer: entry.peerDeviceId,
      entry,
      sounded: false,
    };
    open.set(id, s);
  } else if (tag.m !== s.m || s.ks.has(tag.k)) {
    return;
  }
  s.ks.add(tag.k);
  s.count += savedCount;
  if (s.paths.length < MAX_PATHS) {
    s.paths.push(...(entry.savedPaths ?? []).slice(0, MAX_PATHS - s.paths.length));
  }
  s.entry = entry;
  s.deviceName = extra.deviceName ?? s.deviceName;
  clearTimeout(s.timer);
  s.timer = undefined;
  if (s.ks.size >= s.m) {
    open.delete(id);
    closed.add(id);
    if (closed.size > MAX_CLOSED) closed.delete(closed.values().next().value as string);
    // The sound plays once for each share. The timer can play it first.
    await postShare(key, s, !s.sounded, now);
    return;
  }
  if (!s.sounded) {
    const state = s;
    state.timer = setTimeout(() => {
      // The next batch did not come in 3 minutes. Play the sound with the
      // count so far. Keep the state: a later batch adds to the count.
      state.timer = undefined;
      if (open.get(id) !== state) return;
      state.sounded = true;
      void postShare(key, state, true, Date.now());
    }, TIMEOUT_MS);
  }
  await postShare(key, s, false, now);
}
