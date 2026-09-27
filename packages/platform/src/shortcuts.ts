import NativeDaakShare from '@daak/rn-share';
import type { DeviceInfo } from '@daak/core';

/**
 * Publishes the peer list to the platform shortcut/intent layer. ONE native
 * method, both platforms: Android turns it into `daak.send.<deviceId>` dynamic
 * shortcuts, iOS writes it to the App Group `pairedDevices` key that
 * DaakIntentBridge reads to answer the Siri entity query (R26). There is no JS
 * other than this file on that path, so the TurboModule is the only way to it.
 */
export async function syncShortcutTargets(devices: DeviceInfo[]): Promise<void> {
  // `[]` is a real answer: a device that was unpaired must disappear from Siri
  // and from the share sheet, so the empty list is written, not skipped.
  const slim = devices.map((d) => ({ deviceId: d.deviceId, name: d.name }));
  await NativeDaakShare.updateShortcutTargets(JSON.stringify(slim));
}
