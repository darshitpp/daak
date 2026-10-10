/**
 * The prototype's per-row sheet has two verbs. They are INJECTED, like the
 * file picker: "show in folder" is a different native call on every platform
 * (Android opens a viewer through its FileProvider, iOS deliberately has no
 * reveal at all, macOS has none either) and the share sheet is a TurboModule
 * packages/ui must not import. A row renders a verb only when the host
 * supplied it and the entry actually saved files -- a button wired to nothing
 * is worse than no button. `open` answers whether the OS actually opened it:
 * reveal is a no-op on iOS by design (R41), and a button that silently does
 * nothing there is the failure the user would report.
 */
export interface InboxActions {
  open?: (path: string) => Promise<boolean>;
  share?: (paths: string[]) => void;
  /**
   * R42i: put a received TEXT back on the clipboard. Injected for the same
   * reason as `share` -- packages/ui imports no clipboard TurboModule. A row
   * renders the button only for a text entry AND only when the host supplied
   * the verb.
   */
  copy?: (text: string) => void;
}

