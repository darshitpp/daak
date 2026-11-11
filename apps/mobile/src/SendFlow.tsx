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
import type { MediaHost } from '@daak/ui';

export const pickAttachedFiles = (): Promise<string[]> => pickFiles(true);

/** The folder picker of the composer menu. It copies the folder and resolves the path of the copy. */
export const pickAttachedFolder = (): Promise<string | null> => pickFolder();

/** The photo picker of the composer menu. `fits` compares the picked sizes with the free space. */
export const attachedMedia: MediaHost = {
  pick: pickMedia,
  materialize: materializeMedia,
  fits: async (refs) => fits(refs.reduce((n, r) => n + (r.size ?? DEFAULT_ITEM_BYTES), 0), await freeBytes()),
};
