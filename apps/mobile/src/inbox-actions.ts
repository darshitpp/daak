import { copyToClipboard, presentShare, revealInFileManager } from '@daak/platform';
import type { InboxActions } from '@daak/ui';

// The Inbox row's two real verbs, wired to the native calls that already exist:
//
// revealInFileManager opens a viewer on Android through the FileProvider and
// resolves FALSE on iOS by design (R41 -- iOS has no public reveal), which is
// why HistoryScreen shows a note instead of pretending. presentShare is the OS
// share sheet, and it works on both. Neither is a send: the encrypted send
// goes through the engine's outbox.
//
// Injected rather than imported inside packages/ui, which takes no
// @daak/platform dependency and no TurboModule.
export const mobileInboxActions: InboxActions = {
  open: (path) => revealInFileManager(path),
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
