import React from 'react';
import { SafeAreaView } from 'react-native';
import { AppShell, EngineProvider } from '@daak/ui';
import { engine } from './bootstrap';

export default function App() {
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <EngineProvider engine={engine}>
        <AppShell />
      </EngineProvider>
    </SafeAreaView>
  );
}
