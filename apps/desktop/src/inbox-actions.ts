import { shareViaSystem } from '@daak/rn-share/js/system-share';
import { fileSizes, openFile } from '@daak/platform/src/fspaths';
import type { InboxActions } from '@daak/ui';

// Deep imports for the reason src/picker.ts records: the @daak/rn-share barrel
// default-exports a TurboModuleRegistry.getEnforcing('DaakShare') call, and
// macOS registers 'DaakSystemShare' instead. The fspaths facade is a deep
// import for the same reason shells.tsx uses one. The DaakFsPaths pod IS linked
// on macOS (apps/desktop/macos/Podfile.lock).
//
// open: NSWorkspace opens the file in its default app (Preview for a PDF).
// share: NSSharingServicePicker (RNShare.mm).
// ponytail: add "show in Finder" through revealInFileManager when a desktop
// row demonstrably needs it.
export const desktopInboxActions: InboxActions = {
  open: (path) => openFile(path),
  share: (paths) => {
    void shareViaSystem({ files: paths }).catch(() => {});
  },
  fileSizes: (paths) => fileSizes(paths),
  // NO `copy`. modules/rn-clipboard is not in apps/desktop/macos/Podfile.lock,
  // so NativeDaakClipboard's getEnforcing('DaakClipboard') throws at
  // module-eval time and would take the whole desktop bundle down with it. The
  // button stays hidden here (ThreadScreen renders it only when the host
  // supplies the verb) until the pod is added and the app is rebuilt.
};

