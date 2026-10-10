/**
 * The sender's device id inside the JSON that a received-file notification
 * carries (an `InboxEntry`), or undefined. A payload that does not parse, or
 * an id that is not 32 hex characters, names nobody.
 */
export function peerOfPayload(payload: string): string | undefined {
  try {
    const v: unknown = JSON.parse(payload || '{}');
    const id = typeof v === 'object' && v !== null ? (v as { peerDeviceId?: unknown }).peerDeviceId : undefined;
    return typeof id === 'string' && /^[0-9a-f]{32}$/i.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

