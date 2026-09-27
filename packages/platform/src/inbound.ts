import NativeDaakShare from '@daak/rn-share';

// FROZEN (R7): Task 6's Android stageIntentSend and Task 7's App Intents must
// emit exactly these three arms. Do not add, rename or drop a field.
export type InboundShareItem =
  | { kind: 'text'; text: string }
  | { kind: 'file'; path: string; name: string; mime?: string }
  | { kind: 'intent-send'; deviceId: string; text?: string };

/**
 * Drain everything the platform share sheet staged in the App Group inbox.
 * This is NOT a send. Once Tasks 7/9/11 land, the engine's outbox is what will
 * pick these items up. A batch the native side could not parse is dropped
 * there, not here, so a corrupt payload must never throw into the app.
 */
export async function consumePendingShare(): Promise<InboundShareItem[]> {
  const raw = await NativeDaakShare.consumePendingInbox();
  return parseItems(raw);
}

/** Narrowing guard for the one arm that has a destination already chosen. */
export function isIntentSend(item: InboundShareItem): item is Extract<InboundShareItem, { kind: 'intent-send' }> {
  return item.kind === 'intent-send';
}

/**
 * Drain ONLY the intent-send subdir (R25). This is a SEPARATE native method
 * from consumePendingInbox on purpose: that one is all-or-nothing and deletes
 * every text/file batch it hands back. Nothing routes a text/file item until
 * Task 11, so calling it from the intent path would delete those batches and
 * orphan the bytes they name -- silent data loss. `batches/` is left alone.
 */
export async function consumeIntentSends(): Promise<InboundShareItem[]> {
  const raw = await NativeDaakShare.consumeIntentSends();
  // Belt and braces: the dir is supposed to hold intent-send items only, but a
  // hand-edited file must not be able to turn into a send on this path.
  return parseItems(raw).filter(isIntentSend);
}

function parseItems(raw: string): InboundShareItem[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as InboundShareItem[]) : [];
  } catch {
    return [];
  }
}
