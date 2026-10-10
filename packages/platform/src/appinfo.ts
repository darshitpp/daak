import { TurboModuleRegistry } from 'react-native';
import type { Spec as NotifySpec } from '@daak/rn-notify/js/NativeDaakNotify';
import type { Spec as SystemNotifySpec } from '@daak/rn-notify/js/NativeDaakSystemNotify';

export interface AppInfo {
  version: string;
  build: string;
}

export interface AppInfoSource {
  appInfo(): Promise<string>;
}

const UNKNOWN = 'unknown';

function field(value: unknown): string {
  return typeof value === 'string' && value !== '' ? value : UNKNOWN;
}

/**
 * Pure and never rejects. A missing module, a rejected call, and a JSON value
 * that is not an object all give "unknown". The Settings row must render, so a
 * native defect costs a word and never a screen.
 */
export async function readAppInfo(source: AppInfoSource | null | undefined): Promise<AppInfo> {
  if (!source) return { version: UNKNOWN, build: UNKNOWN };
  try {
    const parsed: unknown = JSON.parse(await source.appInfo());
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { version: UNKNOWN, build: UNKNOWN };
    }
    const fields = parsed as Record<string, unknown>;
    return { version: field(fields.version), build: field(fields.build) };
  } catch {
    return { version: UNKNOWN, build: UNKNOWN };
  }
}

/**
 * The version and build of the installed app. No new native module carries
 * them: mobile asks DaakNotify and macOS asks DaakSystemNotify. `get` returns
 * null for the module the host did not register, where `getEnforcing` throws.
 * So this file needs no wiring in either host.
 */
export function appInfo(): Promise<AppInfo> {
  const source =
    TurboModuleRegistry.get<NotifySpec>('DaakNotify') ??
    TurboModuleRegistry.get<SystemNotifySpec>('DaakSystemNotify');
  return readAppInfo(source);
}

export function formatAppInfo(info: AppInfo): string {
  return `Version ${info.version} (build ${info.build})`;
}
