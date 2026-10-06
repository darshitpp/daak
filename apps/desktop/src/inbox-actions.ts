import { shareViaSystem } from '@daak/rn-share/js/system-share';
import type { InboxActions } from '@daak/ui';

// Deep import for the same reason src/picker.ts records: the @daak/rn-share
// barrel default-exports a TurboModuleRegistry.getEnforcing('DaakShare') call,
// and macOS registers 'DaakSystemShare' instead. This module loads the one
// that does exist here (RNShare.mm: NSSharingServicePicker).
//
// Only Share. "Show in folder" has no macOS implementation in this pass
// (there is no rn-fspaths for macOS), so HistoryScreen simply does not render
// that button rather than shipping a reveal that quietly does nothing.
// ponytail: add reveal via NSWorkspace activateFileViewerSelectingURLs when a
// desktop Inbox row demonstrably needs it.
export const desktopInboxActions: InboxActions = {
  share: (paths) => {
    void shareViaSystem({ files: paths }).catch(() => {});
  },
  // NO `copy`. modules/rn-clipboard is not in apps/desktop/macos/Podfile.lock,
  // so NativeDaakClipboard's getEnforcing('DaakClipboard') throws at
  // module-eval time and would take the whole desktop bundle down with it. The
  // button stays hidden here (HistoryScreen renders it only when the host
  // supplies the verb) until the pod is added and the app is rebuilt.
};
