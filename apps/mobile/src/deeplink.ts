import { Linking } from 'react-native';

export type DeepLink =
  | { kind: 'send'; deviceId: string; text?: string }
  | { kind: 'pair'; bundle: string }
  | { kind: 'none' };

// Parsed off the raw string with indexOf, NOT `new URL`. Hermes has no URL and
// React Native polyfills the global with Libraries/Blob/URL, which is Blob-only:
// it parses without complaint and then throws 'URL.hostname is not implemented'
// on the first accessor. Every daak:// link would have thrown. Percent-decoding
// is the one thing URLSearchParams gave us, so do it by hand (try/catch: a
// malformed escape must fail closed, not throw).
function queryParam(query: string, name: string): string | undefined {
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    if (key !== name) continue;
    const raw = eq === -1 ? '' : pair.slice(eq + 1);
    try {
      return decodeURIComponent(raw.replace(/\+/g, ' '));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Total: any input, valid or garbage, returns a DeepLink and never throws. */
export function parseDeepLink(url: string | null): DeepLink {
  const none: DeepLink = { kind: 'none' };
  if (typeof url !== 'string') return none;
  const schemeEnd = url.indexOf('://');
  if (schemeEnd === -1) return none;
  const scheme = url.slice(0, schemeEnd).toLowerCase();
  if (scheme !== 'daak') return none;

  // Host runs to the first '?', '#' or '/'; a trailing slash is not a segment.
  const rest = url.slice(schemeEnd + 3);
  const hostEnd = firstIndexOfAny(rest, '?#/', 0);
  const host = rest.slice(0, hostEnd === -1 ? rest.length : hostEnd).toLowerCase();
  const tail = rest.slice(hostEnd === -1 ? rest.length : hostEnd);
  const queryAt = tail.indexOf('?');
  const query = queryAt === -1 ? '' : tail.slice(queryAt + 1).split('#')[0];

  if (host === 'send') {
    const deviceId = queryParam(query, 'deviceId');
    if (!deviceId) return none;
    // Omit text entirely when it is absent or empty: `text: ''` is a send of
    // the empty string, and the engine refuses empty sends anyway.
    const text = queryParam(query, 'text');
    return { kind: 'send', deviceId, ...(text ? { text } : {}) };
  }
  if (host === 'pair') {
    const bundle = queryParam(query, 'bundle');
    if (!bundle) return none;
    return { kind: 'pair', bundle };
  }
  return none;
}

function firstIndexOfAny(s: string, chars: string, from: number): number {
  let best = -1;
  for (const c of chars) {
    const i = s.indexOf(c, from);
    if (i !== -1 && (best === -1 || i < best)) best = i;
  }
  return best;
}

export function onDeepLink(cb: (link: DeepLink) => void): () => void {
  // The second .then argument (not .catch) handles the rejection inline:
  // getInitialURL() rejects on a device with no handler, and an unhandled
  // rejection here would take the app down for a link that was optional.
  void Linking.getInitialURL().then((u) => cb(parseDeepLink(u)), () => cb({ kind: 'none' }));
  const sub = Linking.addEventListener('url', ({ url }) => cb(parseDeepLink(url)));
  return () => sub.remove();
}
