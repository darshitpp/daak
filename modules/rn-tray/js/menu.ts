import type { DeviceInfo } from '@daak/core';
import type { TransferRow } from '@daak/ui';

export interface TrayMenuItem {
  id: string;
  label: string;
  separatorBefore?: boolean;
  enabled: boolean;
}

export type TrayAction =
  | { kind: 'send'; deviceId: string }
  | { kind: 'transfer'; transferId: string }
  | { kind: 'dashboard' }
  | { kind: 'quit' };

// The ONLY place a menu id becomes a typed action. buildTrayMenu above is the
// only place a TrayAction's id is minted, so these two lists must move
// together: an id with no case here is dropped, not dispatched.
export function interpretTraySelection(id: string): TrayAction | null {
  if (id.startsWith('send:')) return { kind: 'send', deviceId: id.slice('send:'.length) };
  if (id.startsWith('transfer:')) {
    return { kind: 'transfer', transferId: id.slice('transfer:'.length) };
  }
  if (id === 'dashboard') return { kind: 'dashboard' };
  if (id === 'quit') return { kind: 'quit' };
  return null;
}

export function buildTrayMenu(devices: DeviceInfo[], transfers: TransferRow[]): TrayMenuItem[] {
  const items: TrayMenuItem[] = [];

  // The devices group is always first, so it carries NO leading separator.
  // Separators belong before the TRANSFERS group and before QUIT only.
  //
  // Every KNOWN device is listed, including ones whose liveness is unknown.
  // Do NOT gate on d.online: DaemonClient.devices() goes through parseArray,
  // which never sets `online`, so a cold daemon hands us every peer with
  // online === undefined and the filter would empty the menu. Liveness is not
  // a send precondition either -- Engine::enqueue_outbox_send writes to the
  // outbox durably and only then pokes the peer as an optimisation. This is
  // the same gate Dashboard.tsx removed on purpose; do not reintroduce it.
  devices.forEach((device) => {
    items.push({
      id: `send:${device.deviceId}`,
      label: `Send to ${device.name}`,
      enabled: true,
    });
  });

  transfers
    .filter((t) => t.state === 'active')
    .forEach((row, index) => {
      items.push({
        id: `transfer:${row.transferId}`,
        label: `Transferring ${row.transferId}…`,
        separatorBefore: index === 0,
        enabled: true,
      });
    });

  items.push({ id: 'dashboard', label: 'Open Dashboard', enabled: true });
  items.push({ id: 'quit', label: 'Quit Daak', separatorBefore: true, enabled: true });
  return items;
}
