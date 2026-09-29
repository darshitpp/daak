import { useEffect } from 'react';
import { NativeEventEmitter } from 'react-native';
import type { DeviceInfo } from '@daak/core';
import type { TransferRow } from '@daak/ui';
import NativeDaakTray from './NativeDaakTray';
import { buildTrayMenu } from './menu';

// The Spec declares addListener/removeListeners, so the cast is unnecessary
// and would only hide future drift between Spec and this call site.
const emitter = new NativeEventEmitter(NativeDaakTray);

export function useTrayOverlay(
  devices: DeviceInfo[],
  transfers: TransferRow[],
  onSelect: (id: string) => void,
): void {
  useEffect(() => {
    NativeDaakTray.install();
  }, []);

  useEffect(() => {
    NativeDaakTray.setMenu(JSON.stringify(buildTrayMenu(devices, transfers)));
  }, [devices, transfers]);

  useEffect(() => {
    const subscription = emitter.addListener('DaakTraySelect', (event: { id: string }) =>
      onSelect(event.id),
    );
    return () => subscription.remove();
  }, [onSelect]);
}

export { buildTrayMenu } from './menu';
export type { TrayMenuItem } from './menu';
export { default } from './NativeDaakTray';
export type { Spec } from './NativeDaakTray';
