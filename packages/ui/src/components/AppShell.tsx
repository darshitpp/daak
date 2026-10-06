import React, { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { DeviceInfo } from '@daak/core';
import { DashboardScreen } from '../screens/DashboardScreen';
import { HistoryScreen, type InboxActions } from '../screens/HistoryScreen';
import { SendScreen } from '../screens/SendScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { TransfersScreen } from '../screens/TransfersScreen';
import { TransferProgressScreen } from '../screens/TransferProgressScreen';
import { QuarantineScreen } from '../screens/QuarantineScreen';
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
  alert,
  alertRouteToken,
  settingsRouteToken,
  onCheckConnection,
  onUnpair,
  onPickFiles,
  inboxActions,
  initialPeerDeviceId,
  initialText,
  initialFiles,
  pairBundle,
  inboxRouteToken,
  layout = 'mobile',
}: {
  background?: React.ReactNode;
  pair?: React.ReactNode;
  transfers?: React.ReactNode;
  /**
   * A BLOCKING screen that replaces the tab content entirely: the prototype's
   * update-required and can't-reach screens.
   *
   * A slot, not a screen the shell imports, for the same reason `pair` is one --
   * the facts (which peers, which versions, which outbox rows, what the last
   * engine.devices() rejection said) live on the host, and packages/ui takes no
   * @daak/core runtime and no engine. The shell routes to it; the host decides
   * whether it is warranted.
   *
   * Rendered ABOVE the tab bar and the sidebar rather than inside them: both
   * screens are about the app being unable to proceed, and leaving a working
   * Send tab tappable beside them would contradict that.
   */
  alert?: React.ReactNode;
  /**
   * Bumped by the host to open (or re-open) the `alert` slot. A TOKEN, not a
   * boolean, for the same reason inboxRouteToken is: the same peer re-announces
   * on a timer, and a boolean would put a screen the user already dismissed
   * back in front of them forever.
   */
  alertRouteToken?: string;
  /**
   * Bumped by the host to land the user ON Settings.
   *
   * Both blocking screens offer "Open Settings" -- and a button that only
   * dismisses the screen it is on is a dead button, because the user is told to
   * go somewhere and stays where they were. The host clears its alert token in
   * the same render it bumps this one, so the tab switch and the dismissal
   * cannot disagree.
   *
   * A TOKEN for the same reason inboxRouteToken is one: "go to Settings" has to
   * work every time it is asked for, including twice in a row, and a boolean
   * would only fire on the change.
   */
  settingsRouteToken?: string;
  /**
   * The prototype's "...isn't showing? See what to check" affordances, on
   * Devices and on Settings. Injected because the decision belongs to the host:
   * it owns the engine and is the only thing that can ask whether anybody is
   * actually there.
   */
  onCheckConnection?: () => void;
  /**
   * R42g: drop a pairing. Injected for the same reason as onCheckConnection --
   * packages/ui has no engine, and only the host can reach revokePairing.
   */
  onUnpair?: (d: DeviceInfo) => void;
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
  /**
   * Bumped by the host when a tapped [Open] notification should land on the
   * Inbox. The payload itself is the notification's, not a screen's -- the
   * Inbox already lists the entry -- so the shell only needs the ROUTE, and a
   * repeated tap of the same value is a repeated tap of the same screen.
   */
  inboxRouteToken?: string;
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
  // The "Held back" detail is a ROUTE like transfer detail and pairing, not a
  // modal over the Inbox: the prototype's screen is full-bleed with its own
  // appbar and a back chevron, and it is where the delete confirmation lives.
  // Owned HERE so it works identically on the phone and on the desktop sidebar.
  const [held, setHeld] = useState<{ transferId: string; itemIndex: number } | null>(null);
  const openHeld = (r: { transferId: string; itemIndex: number }) => {
    setHeld(r);
    setTab('history');
  };
  // Two exits, deliberately. Back CLOSES the route; deletion does NOT, because
  // the screen's post-delete "Deleted" state is the only confirmation the user
  // gets that an irreversible thing really happened. Closing on delete would
  // yank them to the Inbox with no acknowledgement at all. The list behind is
  // stale for as long as the route is up, and it re-reads held items on mount
  // (see HistoryScreen), so the row is already gone by the time it is seen.
  const closeHeld = () => setHeld(null);

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

  useEffect(() => {
    if (inboxRouteToken !== undefined) setTab('history');
  }, [inboxRouteToken]);

  // "Open Settings" on a blocking screen. NOT folded into the alert token
  // above: that one OPENS the blocking screen, this one CLOSES it and routes,
  // and one flag cannot mean two opposite things.
  useEffect(() => {
    if (settingsRouteToken !== undefined) setTab('settings');
  }, [settingsRouteToken]);

  // The blocking screens are NOT a tab: they take over the whole content area
  // and the tab bar goes away, because both mean "Daak cannot send right now".
  //
  // The token is the WHOLE decision and the host owns it. It opens the screen
  // only for a peer it has not shown one for before, so a peer re-announcing on
  // a timer cannot re-open a screen the user dismissed -- which a boolean here
  // could not express, and which a second dismissal copy inside the shell would
  // only risk disagreeing with.
  const blocking = alert !== undefined && alertRouteToken !== undefined;

  // A held-back item was NOT delivered, so it is deliberately absent from the
  // inbox list the shell fetches. The screen resolves it from the ENGINE by id
  // instead, which is what makes the navigation real rather than a re-display
  // of something the host already had.
  if (held !== null) {
    return (
      <View style={ui.screen} testID="quarantine-route">
        <QuarantineScreen
          transferId={held.transferId}
          itemIndex={held.itemIndex}
          onBack={closeHeld}
        />
      </View>
    );
  }

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
      <DashboardScreen
        onSend={routeSend}
        onPair={openPair}
        onUnpair={onUnpair}
        onCompose={() => setTab('send')}
        onCheckConnection={onCheckConnection}
      />
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
      <HistoryScreen actions={inboxActions} onOpenHeld={openHeld} />
    ) : tab === 'settings' ? (
      <SettingsScreen background={background} onCheckConnection={onCheckConnection} />
    ) : (
      <View style={ui.screen}>
        {pair}
        {back ? <View style={{ padding: spacing.lg, paddingTop: 0 }}><Btn variant="ghost" block testID="pair-back" label="Back to devices" onPress={back} /></View> : null}
      </View>
    );

  return (
    <View style={ui.screen}>
      {blocking ? (
        // No tab bar and no sidebar: both screens say Daak cannot proceed, and
        // a tappable Send tab beside that claim is a lie about what works.
        <View style={{ flex: 1 }} testID="alert-route">
          {alert}
        </View>
      ) : layout === 'desktop' ? (
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
