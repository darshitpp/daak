// R42p: move a received payload's files to the folder the user chose, then tell
// the engine where they went.
//
// Its OWN module and its OWN subscription, rather than a branch inside
// src/notify.ts: that module's engine is a narrow NotifyEngine, and widening it
// to reach revoke/replaceInbox would make a notification module know about the
// filesystem. The desktop is not pinned to one subscription the way
// apps/mobile/src/bootstrap.ts is -- the runtime store and the URL listener each
// hold their own -- so a small one here is the shape this app already uses.
//
// Deep import, not the @daak/platform barrel: that barrel re-exports every
// platform module and each one resolves a TurboModule at module-eval time,
// which is the trap index.js:14-22 records in full.
import { relocateReceivedFiles } from '@daak/platform/src/fspaths';
import type { DaakEngine } from '@daak/core/src/engine/types';

export function relocateInboxFiles(engine: DaakEngine): () => void {
  return engine.on((event) => {
    if (event.type !== 'inbox.received') return;
    // relocateReceivedFiles never throws: it runs on an event handler, where an
    // unhandled rejection takes the subscription and every later event with it.
    void relocateReceivedFiles(engine, event.payload);
  });
}
