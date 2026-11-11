/**
 * The composer's file picker, injected by the app.
 *
 * The composer lives in the shared ThreadScreen now, and DaakUiApp threads its
 * picker down as a prop. packages/ui must not import a TurboModule, so the real
 * pickFiles stays here and App.tsx hands it over.
 *
 * ponytail: delete this file with the shell's next rename. It exists so the
 * imports below keep working while that is a separate concern.
 */
import { DEFAULT_ITEM_BYTES, fits, freeBytes, materializeMedia, pickFiles, pickFolder, pickMedia } from '@daak/platform';
import type { BatchHost, MediaHost } from '@daak/ui';
import { batchDriver, onBatchChange } from './bootstrap';

export const pickAttachedFiles = (): Promise<string[]> => pickFiles(true);

/** The folder picker of the composer menu. It copies the folder and resolves the path of the copy. */
export const pickAttachedFolder = (): Promise<string | null> => pickFolder();

/** The photo picker of the composer menu. `fits` compares the picked sizes with the free space. */
export const attachedMedia: MediaHost = {
  pick: pickMedia,
  materialize: materializeMedia,
  fits: async (refs) => fits(refs.reduce((n, r) => n + (r.size ?? DEFAULT_ITEM_BYTES), 0), await freeBytes()),
  // A selection that does not fit goes to the driver. The screen maps the errors.
  startLarge: async (peerId, refs) => {
    await batchDriver().start(peerId, refs);
  },
};

/** The state of a large send, for the waiting row in the thread. */
export const batchHost: BatchHost = {
  // The driver does not exist before the engine starts. No plan shows until then.
  status: (peerId) => {
    try {
      return batchDriver().status(peerId);
    } catch (e) {
      if (e instanceof Error && e.message === 'NOT_READY') return null;
      throw e;
    }
  },
  retry: (peerId) => batchDriver().retry(peerId),
  stop: (peerId) => batchDriver().stop(peerId),
  subscribe: onBatchChange,
};
