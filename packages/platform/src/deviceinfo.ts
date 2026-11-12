import { Platform } from 'react-native';

/** The part of React Native `Platform` that the report reads. */
export interface PlatformLike {
  OS: string;
  Version: string | number;
  constants?: Record<string, unknown>;
}

const text = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');

/**
 * Report lines about the OS and the device: `os:`, `device:`, and `react_native:`.
 * A missing field gives no word. The read never throws. The lines carry no
 * name, no id, and no address of the user.
 */
export function describePlatform(p: PlatformLike): string {
  try {
    const c = p.constants ?? {};
    const lines: string[] = [];
    const osName = text(c.systemName) || p.OS;
    const release = text(c.Release) || text(c.osVersion);
    // Android: Release is "16" and Version is the API level. Apple: Version is the OS version.
    const osVersion = p.OS === 'android' ? `${release} (API ${text(p.Version)})`.trim() : text(p.Version) || release;
    lines.push(`os: ${osName} ${osVersion}`.trim());
    const device = [text(c.Manufacturer) || text(c.Brand), text(c.Model)].filter((s) => s !== '').join(' ');
    const idiom = text(c.interfaceIdiom);
    if (device !== '' || idiom !== '') lines.push(`device: ${device !== '' ? device : idiom}`);
    const rn = c.reactNativeVersion as { major?: number; minor?: number; patch?: number } | undefined;
    if (rn && typeof rn.major === 'number') lines.push(`react_native: ${rn.major}.${rn.minor ?? 0}.${rn.patch ?? 0}`);
    return lines.join('\n') + '\n';
  } catch {
    return '';
  }
}

/** The report lines for this device. */
export function deviceInfo(): string {
  return describePlatform(Platform as unknown as PlatformLike);
}
