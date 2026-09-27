import { Linking } from 'react-native';

export type DeepLink =
  | { kind: 'send'; deviceId: string; text?: string }
  | { kind: 'pair'; bundle: string }
  | { kind: 'none' };

export function parseDeepLink(url: string | null): DeepLink {
  if (!url || !url.startsWith('daak://')) return { kind: 'none' };
  const u = new URL(url);
  if (u.hostname === 'send') {
    return { kind: 'send', deviceId: u.searchParams.get('deviceId') ?? '', text: u.searchParams.get('text') ?? undefined };
  }
  if (u.hostname === 'pair') return { kind: 'pair', bundle: u.searchParams.get('bundle') ?? '' };
  return { kind: 'none' };
}

export function onDeepLink(cb: (link: DeepLink) => void): () => void {
  void Linking.getInitialURL().then((u) => cb(parseDeepLink(u)));
  const sub = Linking.addEventListener('url', ({ url }) => cb(parseDeepLink(url)));
  return () => sub.remove();
}
