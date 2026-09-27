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
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as InboundShareItem[]) : [];
  } catch {
    return [];
  }
}
