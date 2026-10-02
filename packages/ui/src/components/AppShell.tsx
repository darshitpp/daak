import React, { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { DeviceInfo } from '@daak/core';
import { DashboardScreen } from '../screens/DashboardScreen';
import { HistoryScreen, type InboxActions } from '../screens/HistoryScreen';
import { SendScreen } from '../screens/SendScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { TransfersScreen } from '../screens/TransfersScreen';
import { TransferProgressScreen } from '../screens/TransferProgressScreen';
import { TabBar, type Tab } from './TabBar';
import { Btn } from './ds';
import { spacing, ui } from '../theme';

/**
 * `background`, `pair` and `transfers` are SLOTS: the shell stays
 * presentational and the host app supplies the content (R100).
 *
 * The composer is no longer a permanent strip above the tabs -- it IS the Send
 * tab. One send surface, and a device list that stays readable. DeviceCard's
 * Send is a ROUTE into that tab with the tapped peer as the target, so the
 * host does not need an onSend callback for the button to be real.
 *
 * `initialPeerDeviceId` / `initialText` / `pairBundle` are the daak:// link
 * targets. They ROUTE as well as seed: a link that fills the composer but
 * leaves the user on the Devices tab has not been handled. Same-value repeats
 * do not re-route -- the peer/text is already what is on screen.
 */
export function AppShell({
  background,
  pair,
  transfers,
  onPickFiles,
  inboxActions,
  initialPeerDeviceId,
  initialText,
  initialFiles,
  pairBundle,
  layout = 'mobile',
}: {
  background?: React.ReactNode;
  pair?: React.ReactNode;
  transfers?: React.ReactNode;
  onPickFiles?: () => Promise<string[]>;
  /** The host's native "show in folder" / share-sheet calls for Inbox rows. */
  inboxActions?: InboxActions;
  /** A daak://send?deviceId=... target. Names no device => no target, no fallback. */
  initialPeerDeviceId?: string;
  /** A daak://send?text=... note, prefilled into the composer. */
  initialText?: string;
  /** An OS share-sheet import: files staged natively and drained into Send. */
  initialFiles?: string[];
  /** A daak://pair?bundle=... payload. Opens the pair route; the host's `pair` node owns the flow. */
  pairBundle?: string;
  layout?: 'mobile' | 'desktop';
}) {
  const [tab, setTab] = useState<Tab>('send');
  const [peer, setPeer] = useState<DeviceInfo | null>(null);
  const routeSend = (d: DeviceInfo) => {
    setPeer(d);
    setTab('send');
  };
  const openPair = pair ? () => setTab('pair') : undefined;
  // Transfer detail is a ROUTE, not a modal: per-item transfer.item rows only
  // exist inside it, and TransferProgressScreen had no render site at all.
  const [detail, setDetail] = useState<string | null>(null);
  const openDetail = (id: string) => {
    setDetail(id);
    setTab('transfers');
  };
  // Pairing is a route, so it needs a way OUT as much as a way in: the tab bar
  // keeps showing the five destinations and none of them is highlighted, so on
  // a desktop sidebar there is nothing to click back to. One button, rendered
  // only while the pair route is open.
  const back = tab === 'pair' ? () => setTab('devices') : undefined;

  // ponytail: keyed on the string values, so an OS re-delivery of the SAME
  // link does not re-route. Upgrade to a link counter if the platform is ever
  // seen delivering one URL twice per session.
  useEffect(() => {
    if (initialPeerDeviceId !== undefined) setTab('send');
    else if (pairBundle !== undefined) setTab('pair');
    // A drained OS share is a Send instruction the same way a link is. Without
    // this the seeded composer can sit behind another tab and the imported
    // bytes look like they vanished -- they are already off the native inbox.
    else if (initialFiles !== undefined || initialText !== undefined) setTab('send');
  }, [initialPeerDeviceId, pairBundle, initialFiles, initialText]);

  const screen =
    tab === 'send' ? (
      <SendScreen
        peer={peer}
        initialPeerDeviceId={initialPeerDeviceId}
        initialText={initialText}
        initialFiles={initialFiles}
        onPickFiles={onPickFiles}
        onPeerChange={setPeer}
      />
    ) : tab === 'devices' ? (
      <DashboardScreen onSend={routeSend} onPair={openPair} />
    ) : tab === 'transfers' ? (
      // A host MAY pass its own transfers view; the default is the real one,
      // so a shell that passes nothing still shows every transfer instead of a
      // blank tab (the desktop used to render nothing at all here).
      detail === null ? (
        transfers ?? <TransfersScreen onOpen={openDetail} />
      ) : (
        <View style={ui.screen}>
          <View style={ui.appbar}>
            <Text style={ui.appbarTitle}>This transfer</Text>
            <Btn label="Back" variant="ghost" onPress={() => setDetail(null)} testID="detail-back" />
          </View>
          <ScrollView contentContainerStyle={ui.pad}>
            <TransferProgressScreen transferId={detail} />
          </ScrollView>
        </View>
      )
    ) : tab === 'history' ? (
      <HistoryScreen actions={inboxActions} />
    ) : tab === 'settings' ? (
      <SettingsScreen background={background} />
    ) : (
      <View style={ui.screen}>
        {pair}
        {back ? <View style={{ padding: spacing.lg, paddingTop: 0 }}><Btn variant="ghost" block testID="pair-back" label="Back to devices" onPress={back} /></View> : null}
      </View>
    );

  return (
    <View style={ui.screen}>
      {layout === 'desktop' ? (
        <View style={ui.desk}>
          <View style={ui.sidebar}>
            <TabBar tab={tab} onChange={setTab} layout="desktop" />
          </View>
          <View style={{ flex: 1 }}>{screen}</View>
        </View>
      ) : (
        <>
          <View style={{ flex: 1 }}>{screen}</View>
          <TabBar tab={tab} onChange={setTab} layout="mobile" />
        </>
      )}
    </View>
  );
}
