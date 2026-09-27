import React, { useState } from 'react';
import { View } from 'react-native';
import { DashboardScreen } from '../screens/DashboardScreen';
import { DevicesScreen } from '../screens/DevicesScreen';
import { HistoryScreen } from '../screens/HistoryScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { TabBar, type Tab } from './TabBar';

export function AppShell() {
  const [tab, setTab] = useState<Tab>('dashboard');
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        {tab === 'dashboard' && <DashboardScreen />}
        {tab === 'devices' && <DevicesScreen />}
        {tab === 'history' && <HistoryScreen />}
        {tab === 'settings' && <SettingsScreen />}
      </View>
      <TabBar tab={tab} onChange={setTab} />
    </View>
  );
}
