// Codegen spec for the `Daak` TurboModule. Method names and argument types
// mirror crates/daak-ffi/src/daak.udl (the source of truth) exactly -- this file
// is what codegen turns into the NativeDaakSpec base class DaakModule.kt extends.
// UDL also has accept_pairing/cancel/retry, which the task brief's method list
// omits; the UDL wins, so they are here.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /** UDL: start(string data_dir, string display_name, u16 listen_port) */
  start(dataDir: string, displayName: string, listenPort: number): Promise<void>;
  /** UDL: pairing_bundle() -> {cbor, name, device_id} (R11) */
  pairingBundle(): Promise<string>;
  /** UDL: offer_pairing(sequence<u8> bundle_cbor) -- the RE-ARM path, peer known */
  offerPairing(bundleCbor: number[]): Promise<void>;
  /** UDL: arm_host_pairing() -- spec 3.3 Mode A host arm, takes no bundle */
  armHostPairing(): Promise<void>;
  /** UDL: pair_with(string addr, sequence<u8> bundle_cbor) -> {sas, peer_device_id} */
  pairWith(addr: string, bundleCbor: number[]): Promise<string>;
  /** UDL: accept_pairing() -> the inbound SAS string */
  acceptPairing(): Promise<string>;
  /** UDL: send_text(string peer_id, string text) -> payload id hex */
  sendText(peerId: string, text: string): Promise<string>;
  /** UDL: send_files(string peer_id, sequence<string> paths) -> payload id hex */
  sendFiles(peerId: string, paths: string[]): Promise<string>;
  /** UDL: list_devices() -> [{deviceId, name, addr}] (R11) */
  listDevices(): Promise<string>;
  /** UDL: revoke_pairing(string device_id) */
  revokePairing(deviceId: string): Promise<void>;
  /** UDL: background_wake() -- drain the outbox now. Rust stub until Task 4. */
  backgroundWake(): Promise<void>;
  /** UDL: replace_inbox_paths(string payload_id, sequence<string> paths) */
  replaceInboxPaths(payloadId: string, paths: string[]): Promise<void>;
  /** UDL: cancel(string transfer_id) */
  cancel(transferId: string): Promise<void>;
  /** UDL: retry(string transfer_id) */
  retry(transferId: string): Promise<void>;
  /** UDL: retry_item(string transfer_id, u32 item_index) */
  retryItem(transferId: string, itemIndex: number): Promise<void>;
  /** UDL: quarantine_report(string transfer_id, u32 item_index) -> JSON */
  quarantineReport(transferId: string, itemIndex: number): Promise<string>;
  /** UDL: list_quarantine_reports() -> JSON array of the same shape */
  listQuarantineReports(): Promise<string>;
  /** UDL: delete_quarantined(string transfer_id, u32 item_index) */
  deleteQuarantined(transferId: string, itemIndex: number): Promise<void>;
  /** UDL: list_transfers(string filter_json) -> [{transferId, peerDeviceId, ...}] */
  listTransfers(filterJson: string): Promise<string>;
  /** UDL: list_inbox() -> [{payloadId, transferId, ..., savedPaths}] */
  listInbox(): Promise<string>;
  /** UDL: self_profile() -> JSON `{name, deviceId}` -- this device's own */
  selfProfile(): Promise<string>;
  /** UDL: set_display_name(string name) */
  setDisplayName(name: string): Promise<void>;
  /** UDL: set_presence(string state) -- 'online' | 'away' */
  setPresence(state: string): Promise<void>;
  /** UDL: local_port() -> u16 */
  localPort(): Promise<number>;
  /** UDL: shutdown() */
  shutdown(): Promise<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Daak');
