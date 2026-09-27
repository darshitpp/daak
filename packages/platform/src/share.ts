import NativeDaakShare from '@daak/rn-share';

export interface ShareRequest { text?: string; urls?: string[]; mime?: string }

// `present` hands bytes to the OS share sheet only. It is NOT a send: the
// encrypted send goes through the engine's outbox, which is what makes
// "queued" mean durably accepted rather than delivered.
export async function presentShare({ text = '', urls = [], mime = '*/*' }: ShareRequest): Promise<void> {
  await NativeDaakShare.present(text, urls, mime);
}

export async function pickFiles(multiple = true): Promise<string[]> {
  return NativeDaakShare.pickDocuments(multiple);
}

/** Raw JSON array of staged inbound items; `inbound.ts` (Task 5) parses it. */
export async function consumePendingInbox(): Promise<string> {
  return NativeDaakShare.consumePendingInbox();
}
