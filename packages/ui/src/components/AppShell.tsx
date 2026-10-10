import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { DeviceInfo } from '@daak/core';
import { DashboardScreen } from '../screens/DashboardScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { ThreadScreen } from '../screens/ThreadScreen';
import { QuarantineScreen } from '../screens/QuarantineScreen';
import type { InboxActions } from '../inbox-actions';
import { TabBar, type Tab } from './TabBar';
import { Btn, type DeviceNoun } from './ds';
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
  onPickFiles,
  inboxActions,
  initialPeerDeviceId,
  initialText,
  initialFiles,
  pairBundle,
  inboxRouteToken,
  inboxPeerDeviceId,
  layout = 'mobile',
  deviceNoun,
  windowChrome,
  keyboardAvoiding,
}: {
  background?: React.ReactNode;
  pair?: React.ReactNode;
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
  /** R42p: the download-folder row. Injected: the picker is a platform call. */
  downloadFolder?: {
    load: () => Promise<string | null>;
    choose: () => Promise<string | null>;
    reset?: () => Promise<void>;
  };
  onPickFiles?: () => Promise<string[]>;
  /** The host's native verbs for thread items: copy, open, share. */
  inboxActions?: InboxActions;
  initialPeerDeviceId?: string;
  initialText?: string;
  initialFiles?: string[];
  pairBundle?: string;
  inboxRouteToken?: string;
  inboxPeerDeviceId?: string;
  layout?: 'mobile' | 'desktop';
  /** "phone" or "Mac" in copy. A prop, because this package has no platform check. */
  deviceNoun?: DeviceNoun;
  /** The desktop window header text. */
  windowChrome?: { title: string; version?: string };
  /** Lift the composer above the keyboard. The iOS host sets it. */
  keyboardAvoiding?: boolean;
}) {
  const [root, setRoot] = useState<Tab>('devices');
  const [stack, setStack] = useState<Route[]>([]);
  const [share, setShare] = useState<Share | null>(null);
  const ids = useRef(0);

  const route = (b: RouteBody): Route => ({ ...b, id: (ids.current += 1) });
  const push = (b: RouteBody) => setStack((s) => [...s, route(b)]);
  const pop = () => setStack((s) => s.slice(0, -1));
  const goRoot = (t: Tab) => {
    setRoot(t);
    setStack([]);
  };

  const openThread = (d: DeviceInfo) => {
    push({ name: 'thread', peerDeviceId: d.deviceId, text: share?.text, files: share?.files });
    setShare(null);
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
  }, [initialPeerDeviceId, pairBundle, initialFiles, initialText]);

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
      />
    );
  } else if (shown !== undefined) {
    screen = (
      <View style={ui.screen}>
        {pair}
        <View style={{ padding: spacing.lg, paddingTop: 0 }}>
          <Btn variant="ghost" block testID="pair-back" label="Back to devices" onPress={pop} />
        </View>
      </View>
    );
  } else if (root === 'devices') {
    screen = (
      <DashboardScreen
        onOpenThread={openThread}
        onPair={pair ? () => push({ name: 'pair' }) : undefined}
        onCheckConnection={onCheckConnection}
        pendingShare={share === null ? null : { fileCount: share.files?.length ?? 0, hasText: (share.text ?? '') !== '' }}
      />
    );
  } else {
    screen = (
      <SettingsScreen background={background} onCheckConnection={onCheckConnection} downloadFolder={downloadFolder} />
    );
  }

  const atRoot = stack.length === 0;
  return (
    <View style={ui.screen}>
      {blocking ? (
        // No tab bar: both blocking screens say Daak cannot proceed, and a
        // tappable tab beside that claim is a lie about what works.
        <View style={{ flex: 1 }} testID="alert-route">
          {alert}
        </View>
      ) : (
        <>
          {layout === 'desktop' && atRoot ? (
            <TabBar tab={root} onChange={goRoot} layout="desktop" title={windowChrome?.title} trailing={windowChrome?.version} />
          ) : null}
          <View
            style={{ flex: 1 }}
            pointerEvents={held ? 'none' : 'auto'}
            accessibilityElementsHidden={held !== undefined}
            importantForAccessibility={held ? 'no-hide-descendants' : 'auto'}
          >
            {screen}
          </View>
          {layout === 'mobile' && atRoot ? <TabBar tab={root} onChange={goRoot} layout="mobile" /> : null}
          {held ? (
            <View style={[StyleSheet.absoluteFill, ui.screen]} testID="quarantine-route">
              <QuarantineScreen transferId={held.transferId} itemIndex={held.itemIndex} onBack={pop} />
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

