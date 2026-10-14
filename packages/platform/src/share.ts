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

/** Raw JSON array of staged inbound items; `inbound.ts` (Task 5) parses it. */
export async function consumePendingInbox(): Promise<string> {
  return NativeDaakShare.consumePendingInbox();
}
