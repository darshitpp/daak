import NativeDaakShare from '@daak/rn-share';

export interface ShareRequest { text?: string; urls?: string[]; mime?: string }

// `present` hands bytes to the OS share sheet only. It is NOT a send: the
// encrypted send goes through the engine's outbox, which is what makes
// "queued" mean durably accepted rather than delivered.
//
// `mime` defaults to EMPTY, not to a wildcard. An empty value tells the native
// side to ask the content resolver for each document's own type, which is what
// keeps the chooser from listing every app that accepts any file. Pass an
// explicit type only to override that.
export async function presentShare({ text = '', urls = [], mime = '' }: ShareRequest): Promise<void> {
  // A `photos:` marker names a Photos asset, not a file. The iOS share sheet
  // builds a file URL from each string, so a marker would give a bogus URL.
  const files = urls.filter((u) => !u.startsWith('photos:'));
  // Only markers were given and there is no text: nothing real to share. A call
  // with no urls at all keeps its old behavior.
  if (files.length < urls.length && files.length === 0 && text === '') return;
  await NativeDaakShare.present(text, files, mime);
}

export async function pickFiles(multiple = true): Promise<string[]> {
  return NativeDaakShare.pickDocuments(multiple);
}

/**
 * Ask the user for one folder. Resolves the folder path, or `null` on cancel.
 * Rejects with an `Error` whose message is `NO_SPACE:<needed bytes>`,
 * `EMPTY`, or `NOT_DOWNLOADED` (an iCloud Drive file is not on the device). The bridge can deliver `undefined` for a cancel, so `?? null`
 * absorbs it here. Any other native error passes through unchanged.
 */
export async function pickFolder(): Promise<string | null> {
  if (typeof NativeDaakShare.pickFolder !== 'function') {
    throw new Error('pickFolder is not available on this platform');
  }
  try {
    return (await NativeDaakShare.pickFolder()) ?? null;
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown };
    const message = typeof err.message === 'string' ? err.message : '';
    if (err.code === 'NO_SPACE' && !message.startsWith('NO_SPACE:')) {
      throw new Error(`NO_SPACE:${message}`);
    }
    if (err.code === 'EMPTY' && message !== 'EMPTY') throw new Error('EMPTY');
    if (err.code === 'NOT_DOWNLOADED' && message !== 'NOT_DOWNLOADED') {
      throw new Error('NOT_DOWNLOADED');
    }
    throw e;
  }
}

export type MediaRef = { token: string; name: string; size: number | null };

const isMediaRef = (v: unknown): v is MediaRef => {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as { token?: unknown; name?: unknown; size?: unknown };
  return (
    typeof r.token === 'string' &&
    typeof r.name === 'string' &&
    (r.size === null || (typeof r.size === 'number' && Number.isFinite(r.size) && r.size >= 0))
  );
};

/**
 * Ask the user for photos and videos. Resolves references only: a token, a
 * name, and a size. Nothing is copied until `materializeMedia`. A cancelled
 * pick gives `[]`. More than 5000 items reject `E_TOO_MANY`. A second pick while
 * one is open rejects `E_PICK_BUSY`. An entry that
 * fails validation is dropped.
 */
export async function pickMedia(): Promise<MediaRef[]> {
  if (typeof NativeDaakShare.pickMedia !== 'function') {
    throw new Error('pickMedia is not available on this platform');
  }
  let raw: unknown;
  try {
    raw = await NativeDaakShare.pickMedia();
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown };
    if (err.code === 'E_TOO_MANY' || err.message === 'E_TOO_MANY') throw new Error('E_TOO_MANY');
    if (err.code === 'E_PICK_BUSY' || err.message === 'a pick is open') throw new Error('E_PICK_BUSY');
    throw e;
  }
  if (typeof raw !== 'string') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter(isMediaRef) : [];
}

/**
 * Copy one picked item into the send cache and resolve the path of the copy.
 * Rejects with an `Error` whose message is `NO_SPACE:<needed bytes>`,
 * `E_SOURCE_GONE`, `NOT_DOWNLOADED`, or `E_MATERIALIZE`. The message holds no name and no URI.
 */
export async function materializeMedia(token: string): Promise<string> {
  if (typeof NativeDaakShare.materialize !== 'function') {
    throw new Error('materialize is not available on this platform');
  }
  try {
    return await NativeDaakShare.materialize(token);
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown };
    const message = typeof err.message === 'string' ? err.message : '';
    if (message.startsWith('NO_SPACE:') && /^NO_SPACE:\d+$/.test(message)) throw new Error(message);
    if (err.code === 'NO_SPACE') throw new Error(`NO_SPACE:${message.replace(/\D/g, '')}`);
    if (err.code === 'E_SOURCE_GONE' || message === 'E_SOURCE_GONE') {
      throw new Error('E_SOURCE_GONE');
    }
    // An iCloud item that did not download keeps its own code: the screen has its text.
    if (err.code === 'NOT_DOWNLOADED' || message === 'NOT_DOWNLOADED') {
      throw new Error('NOT_DOWNLOADED');
    }
    // Any other error gets a fixed message, so no name or URI can pass through.
    throw new Error('E_MATERIALIZE');
  }
}

/** Raw JSON array of staged inbound items; `inbound.ts` (Task 5) parses it. */
export async function consumePendingInbox(): Promise<string> {
  return NativeDaakShare.consumePendingInbox();
}
