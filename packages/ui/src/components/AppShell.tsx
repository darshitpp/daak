import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { DeviceInfo } from '@daak/core';
import { DashboardScreen } from '../screens/DashboardScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { ThreadScreen } from '../screens/ThreadScreen';
import { QuarantineScreen } from '../screens/QuarantineScreen';
import type { InboxActions } from '../inbox-actions';
import type { PhotosHost } from './PhotosAccessRow';
import type { SettingsHost } from '../screens/settings/host';
import { Sidebar, TabBar, type Tab } from './TabBar';
import { Btn, type DeviceNoun } from './ds';
import { useToast } from './Toast';
import { spacing, ui } from '../theme';

type RouteBody =
  | { name: 'thread'; peerDeviceId: string; text?: string; files?: string[] }
  | { name: 'pair' }
  | { name: 'held'; transferId: string; itemIndex: number };
/** `id` changes for each push, so a new link remounts the thread and its composer. */
type Route = RouteBody & { id: number };
type Share = { text?: string; files?: string[] };

/**
 * Two root tabs (Devices, Settings) and a stack of routes above them.
 *
 * `background` and `pair` are SLOTS: the shell stays presentational and the
 * host app supplies the content (R100).
 *
 * `initialPeerDeviceId`, `initialText`, `initialFiles`, and `pairBundle` are
 * the daak:// link targets and the OS share. They ROUTE as well as seed. A
 * share that names no device lands on Devices, which asks for one.
 *
 * `inboxRouteToken` is bumped by the host when a tapped [Open] notification
 * should open the app. `inboxPeerDeviceId` names the sender when the
 * notification does. The token is a counter, not a flag: the same tap twice
 * must route twice.
 */
export function AppShell({
  background,
  pair,
  alert,
  alertRouteToken,
  settingsRouteToken,
  onCheckConnection,
  downloadFolder,
  photos,
  onPickFiles,
  inboxActions,
  onUnpair,
  settingsHost,
  initialPeerDeviceId,
  initialText,
  initialFiles,
  initialShareToken,
  onShareSend,
  onCancelShare,
  pairBundle,
  inboxRouteToken,
  inboxPeerDeviceId,
  layout = 'mobile',
  deviceNoun,
  windowChrome,
  keyboardAvoiding,
  library,
  saveFolder,
  isMedia,
  onPickFolder,
  folderStats,
  discardPickedCopy,
  pickLabel,
}: {
  background?: React.ReactNode;
  pair?: React.ReactNode | ((onPaired: () => void) => React.ReactNode);
  /**
   * A BLOCKING screen that replaces everything: update-required and
   * can't-reach. A slot, because the facts live on the host. It shows only
   * when `alertRouteToken` is also set, so a peer that re-announces on a timer
   * cannot put back a screen the user dismissed.
   */
  alert?: React.ReactNode;
  alertRouteToken?: string;
  /** Bumped by the host to land the user ON Settings. A token, so it works twice in a row. */
  settingsRouteToken?: string;
  /** The "...isn't showing? See what to check" link. The host owns the check. */
  onCheckConnection?: () => void;
  /** R42g. Settings calls revokePairing itself. The host hook runs after it. */
  onUnpair?: (d: DeviceInfo) => void;
  /** The injected Settings functions: arrival prefs, app version, OS grant. */
  settingsHost?: SettingsHost;
  /** R42p: the download-folder row. Injected: the picker is a platform call. */
  downloadFolder?: {
    load: () => Promise<string | null>;
    choose: () => Promise<string | null>;
    reset?: () => Promise<void>;
    canReset?: (name: string) => boolean;
  };
  /** The Photos verbs for the Settings row. Injected: access is a platform call. */
  photos?: PhotosHost;
  onPickFiles?: () => Promise<string[]>;
  /** The host's native verbs for thread items: copy, open, share. */
  inboxActions?: InboxActions;
  initialPeerDeviceId?: string;
  initialText?: string;
  initialFiles?: string[];
  /** A new value shows the share again, even when the files are the same. */
  initialShareToken?: number;
  /** The desktop sends the files at once. Mobile sets none and keeps the composer seed. */
  onShareSend?: (device: DeviceInfo, share: { files: string[]; text?: string }) => Promise<{ cancel: () => Promise<void> } | void>;
  /** The host drops its copy of the share. */
  onCancelShare?: () => void;
  pairBundle?: string;
  inboxRouteToken?: string;
  inboxPeerDeviceId?: string;
  layout?: 'mobile' | 'desktop';
  /** "phone" or "Mac" in copy. A prop, because this package has no platform check. */
  deviceNoun?: DeviceNoun;
  /** The Mac window chrome. The sidebar footer reads `version`. */
  windowChrome?: { version?: string };
  /** Lift the composer above the keyboard. The iOS host sets it. */
  keyboardAvoiding?: boolean;
  /** The media library for the folder sheet. Absent when the host saves no media there. */
  library?: 'Photos' | 'Gallery';
  /** The save folder name for the folder sheet. Absent: the name that the download folder row shows. */
  saveFolder?: string;
  /** True for a file name with a media extension. The host owns the list. */
  isMedia?: (name: string) => boolean;
  /** The phone folder picker. It resolves the path of a copy, or null on Cancel. */
  onPickFolder?: () => Promise<string | null>;
  /** The file count and the size of a folder. Null for a path that is not a folder. */
  folderStats?: (path: string) => Promise<{ files: number; bytes: number } | null>;
  /** Deletes a copy that `onPickFolder` made. */
  discardPickedCopy?: (path: string) => Promise<void>;
  /** The label of the add button when there is no folder menu. macOS sets `Add files or folders`. */
  pickLabel?: string;
}) {
  const [root, setRoot] = useState<Tab>('devices');
  const [stack, setStack] = useState<Route[]>([]);
  const [share, setShare] = useState<Share | null>(null);
  const ids = useRef(0);

  const route = (b: RouteBody): Route => ({ ...b, id: (ids.current += 1) });
  const push = (b: RouteBody) => setStack((s) => [...s, route(b)]);
  const pop = () => setStack((s) => s.slice(0, -1));
  // The pair flow calls this when pairing ends. It pops only the pair route.
  const popPair = () => setStack((s) => (s[s.length - 1]?.name === 'pair' ? s.slice(0, -1) : s));
  const goRoot = (t: Tab) => {
    setRoot(t);
    setStack([]);
  };

  const toast = useToast();
  const sending = useRef(false);
  // Cancel sets this flag while a send runs. The send reads it when it ends.
  const cancelRequested = useRef(false);
  // The latest share. A send in flight compares it to the share that it sent.
  const shareRef = useRef<Share | null>(null);
  shareRef.current = share;

  const openThread = async (d: DeviceInfo) => {
    if (sending.current) return;
    const sent = share;
    const files = share?.files;
    if (onShareSend !== undefined && files !== undefined && files.length > 0) {
      sending.current = true;
      cancelRequested.current = false;
      let handle: { cancel: () => Promise<void> } | void;
      try {
        handle = await onShareSend(d, { files, text: share?.text });
      } catch (e) {
        // The user cancelled. A failed send is the expected result then.
        if (!cancelRequested.current) toast.show(`Could not send: ${e instanceof Error ? e.message : String(e)}`);
        return;
      } finally {
        sending.current = false;
      }
      if (cancelRequested.current) {
        // Cancel ends the send. Do not open the thread. Do not touch a newer share.
        if (handle) {
          try {
            await handle.cancel();
          } catch (e) {
            toast.show(`Could not cancel: ${e instanceof Error ? e.message : String(e)}. The send may still finish.`);
          }
        }
        return;
      }
      // A newer share arrived during the send. Keep it pending. Do not open the thread.
      if (shareRef.current !== sent) return;
      push({ name: 'thread', peerDeviceId: d.deviceId, text: sent?.text });
      setShare(null);
      return;
    }
    push({ name: 'thread', peerDeviceId: d.deviceId, text: share?.text, files });
    setShare(null);
  };

  const cancelShare = () => {
    if (sending.current) cancelRequested.current = true;
    setShare(null);
    onCancelShare?.();
  };

  // ponytail: keyed on the string values, so an OS re-delivery of the SAME
  // link does not re-route. Upgrade to a link counter if the platform ever
  // delivers one URL twice in a session.
  useEffect(() => {
    if (initialPeerDeviceId !== undefined) {
      setShare(null);
      setStack([route({ name: 'thread', peerDeviceId: initialPeerDeviceId, text: initialText, files: initialFiles })]);
    } else if (pairBundle !== undefined) {
      setStack([route({ name: 'pair' })]);
    } else if (initialFiles !== undefined || initialText !== undefined) {
      // A drained OS share names no device. Devices asks for one.
      setRoot('devices');
      setStack([]);
      setShare({ text: initialText, files: initialFiles });
    }
  }, [initialPeerDeviceId, pairBundle, initialFiles, initialText, initialShareToken]);

  // The token alone triggers the route. The peer id is read from the same
  // render, because the host sets both in one batch.
  useEffect(() => {
    if (inboxRouteToken === undefined) return;
    setRoot('devices');
    setStack(
      inboxPeerDeviceId === undefined ? [] : [route({ name: 'thread', peerDeviceId: inboxPeerDeviceId })],
    );
  }, [inboxRouteToken]);

  // "Open Settings" on a blocking screen. NOT folded into the alert token:
  // that one opens the screen, this one closes it and routes.
  useEffect(() => {
    if (settingsRouteToken !== undefined) goRoot('settings');
  }, [settingsRouteToken]);

  const blocking = alert !== undefined && alertRouteToken !== undefined;
  const top = stack[stack.length - 1];

  // A held-back item was NOT delivered, so no list holds it. The screen reads
  // it from the engine by id. Back returns to the thread. Deletion does not
  // close the route: the "Deleted" state is the only confirmation.
  // The held route is an overlay. The thread below it stays mounted, so its
  // composer state and its pages survive the round trip.
  const held = top !== undefined && top.name === 'held' ? top : undefined;
  const shown = held !== undefined ? stack[stack.length - 2] : top;

  // The folder sheet names the save folder with the words of the download
  // folder row. Read it each time a thread opens, so a change in Settings shows.
  const threadId = shown !== undefined && shown.name === 'thread' ? shown.id : undefined;
  const loadFolder = downloadFolder?.load;
  const [folderName, setFolderName] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (threadId === undefined || saveFolder !== undefined || loadFolder === undefined) return undefined;
    let live = true;
    loadFolder().then(
      (n) => { if (live) setFolderName(n ?? "the app's own storage"); },
      () => {},
    );
    return () => { live = false; };
    // The host makes a new downloadFolder object on each render. The thread id is the trigger.
  }, [threadId, saveFolder]);

  let screen: React.ReactNode;
  if (shown !== undefined && shown.name === 'thread') {
    screen = (
      <ThreadScreen
        key={shown.id}
        peerDeviceId={shown.peerDeviceId}
        onBack={pop}
        onPickFiles={onPickFiles}
        actions={inboxActions}
        onOpenHeld={(r) => push({ name: 'held', ...r })}
        initialText={shown.text}
        initialFiles={shown.files}
        deviceNoun={deviceNoun}
        keyboardAvoiding={keyboardAvoiding}
        library={library}
        saveFolder={saveFolder ?? folderName}
        isMedia={isMedia}
        onPickFolder={onPickFolder}
        folderStats={folderStats}
        discardPickedCopy={discardPickedCopy}
        pickLabel={pickLabel}
      />
    );
  } else if (shown !== undefined) {
    screen = (
      <View style={ui.screen}>
        {typeof pair === 'function' ? pair(popPair) : pair}
        <View style={{ padding: spacing.lg, paddingTop: 0 }}>
          <Btn variant="ghost" block testID="pair-back" label="Back to devices" onPress={pop} />
        </View>
      </View>
    );
  } else if (root === 'devices') {
    screen = (
      <DashboardScreen
        onOpenThread={(d) => void openThread(d)}
        onCancelShare={onCancelShare === undefined ? undefined : cancelShare}
        onPair={pair ? () => push({ name: 'pair' }) : undefined}
        onCheckConnection={onCheckConnection}
        pendingShare={share === null ? null : { fileCount: share.files?.length ?? 0, hasText: (share.text ?? '') !== '' }}
      />
    );
  } else {
    screen = (
      <SettingsScreen
        background={background}
        onCheckConnection={onCheckConnection}
        downloadFolder={downloadFolder}
        photos={photos}
        onUnpair={onUnpair}
        settingsHost={settingsHost}
        deviceNoun={deviceNoun}
      />
    );
  }

  const atRoot = stack.length === 0;
  // The sidebar highlight (design NAV_FOR): the thread, the pair route, and
  // the held route all count as Devices.
  const activeNav: Tab = top === undefined ? root : 'devices';
  return (
    <View style={ui.screen}>
      {blocking ? (
        // No tab bar and no sidebar: both blocking screens say Daak cannot
        // proceed, and a tappable destination beside that claim is a lie about
        // what works.
        <View style={{ flex: 1 }} testID="alert-route">
          {alert}
        </View>
      ) : (
        // The Mac window is a 248px sidebar beside the main column (design
        // macos.html). The sidebar stays on every route. The phone keeps its
        // bottom bar, which shows only at a root.
        <View style={layout === 'desktop' ? ui.desk : ui.fill}>
          {layout === 'desktop' ? (
            <Sidebar active={activeNav} onChange={goRoot} version={windowChrome?.version} />
          ) : null}
          <View style={ui.fill}>
            <View
              style={{ flex: 1 }}
              pointerEvents={held ? 'none' : 'auto'}
              accessibilityElementsHidden={held !== undefined}
              importantForAccessibility={held ? 'no-hide-descendants' : 'auto'}
            >
              {screen}
            </View>
            {layout === 'mobile' && atRoot ? <TabBar tab={root} onChange={goRoot} /> : null}
            {held ? (
              <View style={[StyleSheet.absoluteFill, ui.screen]} testID="quarantine-route">
                <QuarantineScreen
                  transferId={held.transferId}
                  itemIndex={held.itemIndex}
                  onBack={pop}
                  deviceNoun={deviceNoun}
                />
              </View>
            ) : null}
          </View>
        </View>
      )}
    </View>
  );
}

