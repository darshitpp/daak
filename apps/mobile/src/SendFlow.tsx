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
import { pickFiles } from '@daak/platform';

export const pickAttachedFiles = (): Promise<string[]> => pickFiles(true);
