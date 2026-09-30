import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DaakEngine } from '@daak/core';

/** App Group inbox the macOS Share Extension stages into. */
export const MACOS_INBOX_DIR = 'share-inbox';
/** Linux watch folder, per the plan's fixed identifiers. */
export const LINUX_WATCH_FOLDER = '~/.local/share/daak/inbox';
/** Darwin notification the extension posts after staging. Deliberately NOT
 *  mobile's `dev.darshit.daak.share.inbox.changed`: the two targets cannot
 *  observe each other and a shared name would make one platform's wakeup look
 *  like the other's (apps/mobile/src/__tests__/notifyManifest.test.ts:265). */
export const INBOX_CHANGED = 'dev.darshit.daak.inbox.changed';

/**
 * Regular files directly in `dir`, sorted, dotfiles skipped. Non-recursive on
 * purpose: a shared file is staged as "<uuid>-<original>" and a manifest as a
 * sibling in a `batches/` subdir, so a directory is the namespace holder and a
 * staged payload can never be read as metadata.
 */
export function scanInbox(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // A watch folder that does not exist yet, or that this user cannot read, is
    // an empty inbox -- not an error. Nothing was staged, so nothing is lost.
    return [];
  }
  return names
    .filter((name) => !name.startsWith('.'))
    .map((name) => join(dir, name))
    .filter((path) => {
      try {
        // lstat, not stat: statSync follows a symlink and would report the
        // TARGET as a regular file, handing daakd a path outside the inbox.
        return lstatSync(path).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * The extension/target only copies assets; staging and crypto stay in the
 * engine. Each inbox file is sent as its own item to the chosen peer.
 *
 * `peerDeviceId` is a real input, not a default: the desktop app has no
 * selected-peer concept yet (Task 7 introduces per-device direct share) and
 * inventing one here would put a platform conditional in packages/ui. A caller
 * must supply the peer.
 *
 * Nothing is deleted from the inbox. daakd's Send hard-links the source into
 * its own staging dir (crates/daak-core/src/staging.rs:37) and owns the
 * lifetime from there, so removing the file here would race the enqueue. The
 * caller deletes once the transfer is `done` or `failed`.
 */
export async function ingestInbox(
  dir: string,
  engine: DaakEngine,
  peerDeviceId: string,
): Promise<number> {
  const files = scanInbox(dir);
  for (const file of files) {
    // One transfer per file, not one per drain: each file was its own share.
    // Awaiting is correct -- Engine::enqueue_outbox_send writes a durable
    // outbox row and returns without blocking on the peer (engine.rs:826), so
    // this serialises IPC round trips, not transfers.
    await engine.send({ peerDeviceId, files: [file] });
  }
  return files.length;
}
