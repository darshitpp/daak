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
  //
  // LAST WRITER WINS IS A BUG HERE, and this used to have it. getInitialURL() is
  // the cold-launch read and the 'url' event is a link into a running app, but
  // the two are not ordered: a warm start delivers the event first and settles
  // the initial read a tick later. Whichever resolved last overwrote the other,
  // so a real pairing link could be replaced by the empty answer -- the app
  // opened the pair route with NO bundle and the join silently did nothing.
  //
  // A `none` is therefore only ever reported when nothing real has been seen.
  // One line, and it is the difference between a link that works and one that
  // silently does not.
  let settled = false;
  const deliver = (url: string | null) => {
    const link = parseDeepLink(url);
    if (settled && link.kind === 'none') return;
    if (link.kind !== 'none') settled = true;
    cb(link);
  };
  void Linking.getInitialURL().then(deliver, () => deliver(null));
  const sub = Linking.addEventListener('url', ({ url }) => deliver(url));
  return () => sub.remove();
}
