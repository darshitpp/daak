import { copyToClipboard, openFile, presentShare } from '@daak/platform';
import type { InboxActions } from '@daak/ui';

// The Inbox row's real verbs, wired to the native calls that exist.
//
// openFile starts a viewer on every platform: QuickLook on iOS, ACTION_VIEW
// through the FileProvider on Android. It resolves FALSE when no viewer
// started, and HistoryScreen then shows a note. presentShare is the OS share
// sheet. Neither is a send: the encrypted send goes through the engine's
// outbox.
//
// Injected rather than imported inside packages/ui, which takes no
// @daak/platform dependency and no TurboModule.
export const mobileInboxActions: InboxActions = {
  open: (path) => openFile(path),
  share: (paths) => {
    // Swallowed on purpose: the share sheet is a user surface, and a rejection
    // there means no sheet was shown -- there is nothing useful to report and
    // no second action to take.
    void presentShare({ urls: paths }).catch(() => {});
  },
  // R42i: put a received text back on the clipboard on demand. routeInboxEntry
  // already copies it once on arrival; this is the row's own verb for a user
  // who copied something else in between.
  copy: (text) => {
    void copyToClipboard(text).catch(() => {});
  },
};
