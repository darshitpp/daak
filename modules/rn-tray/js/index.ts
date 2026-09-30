import { useEffect } from 'react';
import { NativeEventEmitter } from 'react-native';
import type { DeviceInfo } from '@daak/core';
import type { TransferRow } from '@daak/ui';
import NativeDaakTray from './NativeDaakTray';
import { buildTrayMenu, interpretTraySelection } from './menu';
import type { TrayAction } from './menu';

// The Spec declares addListener/removeListeners, so the cast is unnecessary
// and would only hide future drift between Spec and this call site.
const emitter = new NativeEventEmitter(NativeDaakTray);

export function useTrayOverlay(
  devices: DeviceInfo[],
  transfers: TransferRow[],
  onAction: (action: TrayAction) => void,
): void {
  useEffect(() => {
    NativeDaakTray.install();
  }, []);

  useEffect(() => {
    NativeDaakTray.setMenu(JSON.stringify(buildTrayMenu(devices, transfers)));
  }, [devices, transfers]);

  useEffect(() => {
    // The id is interpreted HERE, once, so no caller can ever see a raw menu
    // id and re-parse it differently. An id the router drops is dropped.
    const subscription = emitter.addListener('DaakTraySelect', (event: { id: string }) => {
      const action = interpretTraySelection(event.id);
      if (action) onAction(action);
    });
    return () => subscription.remove();
  }, [onAction]);
}

export { buildTrayMenu, interpretTraySelection } from './menu';
export type { TrayMenuItem, TrayAction } from './menu';
export { default } from './NativeDaakTray';
export type { Spec } from './NativeDaakTray';
