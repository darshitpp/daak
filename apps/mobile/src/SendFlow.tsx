/**
 * The composer's file picker, injected by the app.
 *
 * It used to render ComposerScreen for a peer App.tsx had routed to. Send is a
 * TAB now (packages/ui AppShell), so there is nothing left here to render: the
 * shared SendScreen owns the peer, the note, the attachments and the send
 * button, and App.tsx hands it the one thing only the app can supply --
 * pickFiles, a TurboModule this package must not import.
 *
 * ponytail: delete this file with the shell's next rename. It exists so the
 * imports below keep working while that is a separate concern.
 */
import { pickFiles } from '@daak/platform';

export const pickAttachedFiles = (): Promise<string[]> => pickFiles(true);
