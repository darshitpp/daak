import React from 'react';
import { SafeAreaView } from 'react-native';
import { AppShell, EngineProvider, fakeEngine } from '@daak/ui';

// Placeholder until Task 3 builds the real InProcessEngine over the `Daak`
// TurboModule (apps/mobile/src/bootstrap.ts); Task 3 swaps this line out.
const engine = fakeEngine();

export default function App() {
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <EngineProvider engine={engine}>
        <AppShell />
      </EngineProvider>
    </SafeAreaView>
  );
}
