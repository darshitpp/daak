import type { DaakEvent, DeviceInfo, InboxEntry } from '@daak/core';

export type AppMode = 'popover' | 'dashboard';

export interface TransferRow {
  transferId: string;
  bytesDone: number;
  bytesTotal: number;
  state: 'active' | 'done' | 'failed';
  error?: string;
}

export interface UiState {
  devices: DeviceInfo[];
  transfers: TransferRow[];
  inbox: InboxEntry[];
}

export const initialUiState: UiState = { devices: [], transfers: [], inbox: [] };

/**
 * Not a DaakEvent: the engine never emits it, so it is the store's own input.
 * `device.discovered` is first-ever-only (engine.rs gates it on an `is_new`
 * map with no remover), so on the daemon path a peer that was already on the
 * LAN never fires one. `engine.devices()` is the only complete source, and it
 * arrives as this action instead of a new wire variant.
 */
export type UiAction = DaakEvent | { type: 'devices.loaded'; devices: DeviceInfo[] };

const sameDevices = (a: DeviceInfo[], b: DeviceInfo[]): boolean =>
  a.length === b.length && a.every((d, i) => d === b[i]);

export function reduceUiState(state: UiState, event: UiAction): UiState {
  switch (event.type) {
    case 'device.discovered': {
      const rest = state.devices.filter((d) => d.deviceId !== event.device.deviceId);
      return { ...state, devices: [...rest, event.device] };
    }
    case 'device.state':
      return {
        ...state,
        devices: state.devices.map((d) =>
          d.deviceId === event.deviceId ? { ...d, online: event.state === 'online' } : d,
        ),
      };
    case 'devices.loaded': {
      // F2/R2: a MERGE, not a replace, and not a plain union. The snapshot has
      // no `online` key -- no engine can put one there -- and discovery inserts
      // into the SAME map devices() drains, so an already-discovered device is
      // ALWAYS in the snapshot. Taking the snapshot's copy verbatim stripped
      // the liveness the event had just set. So: the snapshot owns every field
      // it actually carries, and `online` is carried over from the previous
      // entry ONLY when the snapshot omits it. Never invented -- the sole source
      // of a carried value is an `online` an event really set.
      //
      // The append half is still needed: Engine::note_peer seeds the device map
      // from the CLI with no discovery event, so a device can be in the
      // snapshot alone, and a peer that announced can be in state alone.
      const known = new Set(event.devices.map((d) => d.deviceId));
      const previous = new Map(state.devices.map((d) => [d.deviceId, d]));
      const merged = [
        ...event.devices.map((d) => {
          const was = previous.get(d.deviceId);
          return d.online === undefined && was?.online !== undefined ? { ...d, online: was.online } : d;
        }),
        ...state.devices.filter((d) => !known.has(d.deviceId)),
      ];
      // Element IDENTITY: a caller that hands back the very array it was given
      // is a no-op worth skipping; two equal-content arrays are not, and
      // proving they are equal would mean walking every field.
      return sameDevices(state.devices, merged) ? state : { ...state, devices: merged };
    }
    // ponytail: the engine declares TransferProgress with ZERO send sites
    // (engine.rs:92), so a transfer row only ever appears if something else
    // starts emitting it; done/failed then just update an existing row. Make
    // the engine send progress and this ceiling goes away with no store change.
    case 'transfer.progress': {
      const existing = state.transfers.find((t) => t.transferId === event.transferId);
      const row: TransferRow = existing
        ? { ...existing, bytesDone: event.bytesDone, bytesTotal: event.bytesTotal, state: 'active' }
        : {
            transferId: event.transferId,
            bytesDone: event.bytesDone,
            bytesTotal: event.bytesTotal,
            state: 'active',
          };
      const rest = state.transfers.filter((t) => t.transferId !== event.transferId);
      return { ...state, transfers: [...rest, row] };
    }
    case 'transfer.done':
      return {
        ...state,
        transfers: state.transfers.map((t) =>
          t.transferId === event.transferId ? { ...t, state: 'done' } : t,
        ),
      };
    case 'transfer.failed':
      return {
        ...state,
        transfers: state.transfers.map((t) =>
          t.transferId === event.transferId ? { ...t, state: 'failed', error: event.error } : t,
        ),
      };
    case 'inbox.received':
      return { ...state, inbox: [event.payload, ...state.inbox] };
    // `transfer.item` and `pairing.*` carry nothing this store renders, and an
    // event type added to DaakEvent later must not throw here.
    default:
      return state;
  }
}
