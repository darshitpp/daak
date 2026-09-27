import type { InboxEntry } from '@daak/core';
import type { Spec as ClipboardSpec } from '@daak/rn-clipboard';
import NativeDaakClipboard from '@daak/rn-clipboard';

/**
 * What routeInboxEntry is allowed to reach. The clipboard is a NORMAL, required
 * dep rather than a module import, so the test drives a fake typed by this
 * module's own Spec and never by `as any`. Only the one verb it uses is
 * required: adding a method to the Spec must be a deliberate change here.
 */
export interface ReceiveDeps {
  clipboard: Pick<ClipboardSpec, 'setString'>;
}

/**
 * The ONE place an inbound payload becomes a user-visible effect outside the
 * inbox list, reached from the single engine.on subscription in
 * apps/mobile/src/bootstrap.ts.
 *
 * NEVER throws. This runs inside the app's one engine event handler, so an
 * unhandled rejection here kills the subscription and with it every later
 * pairing.done publish and every later notification.
 *
 * This is not a send: it copies to the local clipboard and nothing else. There
 * is no transport, no crypto and no outbox import in this file, so a second
 * send path has nowhere to live.
 */
export async function routeInboxEntry(entry: InboxEntry, deps: ReceiveDeps): Promise<void> {
  // crates/daak-core/src/engine.rs:701-705 -- for PayloadKind::Text the inbox
  // summary IS the first item's text, so there is nothing to fetch or decode.
  if (entry.kind !== 'text') {
    // DELIBERATELY INERT. A file entry's only sensible effect is revealing it in
    // the file manager, and reveal is not implemented on iOS at all (R41) and on
    // Android is reachable only from the notification action, which is still
    // withheld. Pretending to open a file here would either throw or quietly do
    // nothing while claiming it worked; the inbox row is the honest resting
    // state until the UI owns reveal. Returns early rather than throwing, so
    // the notifyReceived sitting next to this call still runs.
    return;
  }
  try {
    await deps.clipboard.setString(entry.summary);
  } catch (err: unknown) {
    console.warn(`daak: could not copy ${entry.payloadId} to the clipboard: ${String(err)}`);
  }
}

/** The production deps: the real clipboard TurboModule. */
export const realReceiveDeps: ReceiveDeps = { clipboard: NativeDaakClipboard };
