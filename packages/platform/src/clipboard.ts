import NativeDaakClipboard from '@daak/rn-clipboard';

/**
 * Copies text to the OS clipboard. The only clipboard verb this app's surface
 * exposes: a LAN-only file app has no business reading what the user copied
 * elsewhere, so there is deliberately no read here (the native module keeps
 * getString for a future paste action, and nothing calls it).
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  return NativeDaakClipboard.setString(text);
}
