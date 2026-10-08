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
  await NativeDaakShare.present(text, urls, mime);
}

export async function pickFiles(multiple = true): Promise<string[]> {
  return NativeDaakShare.pickDocuments(multiple);
}

/** Raw JSON array of staged inbound items; `inbound.ts` (Task 5) parses it. */
export async function consumePendingInbox(): Promise<string> {
  return NativeDaakShare.consumePendingInbox();
}
