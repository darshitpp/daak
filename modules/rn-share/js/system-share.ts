import type { SharePayload } from './items';
import { normalizeShareItems } from './items';
import NativeDaakSystemShare from './NativeDaakSystemShare';

/**
 * Outbound share sheet. NOT a send: the encrypted send goes through the engine
 * outbox (same rule as packages/platform's presentShare).
 */
export async function shareViaSystem(input: { text?: string; files?: string[] }): Promise<void> {
  const payload: SharePayload = normalizeShareItems(input);
  await NativeDaakSystemShare.share(JSON.stringify(payload));
}
