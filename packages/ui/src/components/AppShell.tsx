import React, { useState } from 'react';
import { View } from 'react-native';
import type { DeviceInfo } from '@daak/core';
import { DashboardScreen } from '../screens/DashboardScreen';
import { DevicesScreen } from '../screens/DevicesScreen';
import { HistoryScreen } from '../screens/HistoryScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { TabBar, type Tab } from './TabBar';

/**
 * `background` is threaded to the Settings tab; see SettingsScreen for why.
 *
 * `transfers` and `onSend` exist for the same reason as `pair` (R98/R100): the
 * shell stays presentational and apps/mobile supplies the content. TransferProgressScreen
 * had zero render sites, so the `transfer.item` rows the engine really emits were
 * invisible; `onSend` is what makes the DeviceCard Send button a real route into
 * the composer instead of a no-op.
 */
export function AppShell({
  background,
  pair,
  transfers,
  composer,
  onSend,
}: {
  background?: React.ReactNode;
  pair?: React.ReactNode;
  transfers?: React.ReactNode;
  composer?: React.ReactNode;
  onSend?: (d: DeviceInfo) => void;
}) {
  const [tab, setTab] = useState<Tab>('dashboard');
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        {composer}
        {tab === 'dashboard' && <DashboardScreen onSend={onSend} />}
        {tab === 'devices' && <DevicesScreen onSend={onSend} />}
        {tab === 'transfers' && transfers}
        {tab === 'history' && <HistoryScreen />}
        {tab === 'settings' && <SettingsScreen background={background} />}
        {tab === 'pair' && pair}
      </View>
      <TabBar tab={tab} onChange={setTab} />
    </View>
  );
}
