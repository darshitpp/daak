/** A direct-share route: send these files to THIS device, not to a picker. */
export interface DirectShareRoute {
  deviceId: string;
}

// Hand-rolled with indexOf, NOT `new URL`, for the same reason the mobile
// parser is (apps/mobile/src/deeplink.ts:6-9): react-native-macos polyfills the
// global URL with Libraries/Blob/URL.js from that package. That class is
// Blob-only -- it stores the string and throws on the first accessor:
//
//   react-native-macos/Libraries/Blob/URL.js:142
//   get protocol(): string {
//     throw new Error('URL.protocol is not implemented');
//
// The old claim in this file's header, that desktop runs on JavaScriptCore and
// so gets a real URL, was false. The RN polyfill replaces the global before any
// app code runs, and vitest runs on Node, where URL IS real -- which is why the
// suite was green while the running macOS app reported
// 'URL.protocol is not implemented'. test/routes.spec.ts now installs a local
// copy of the shim as the global URL so the defect cannot go unseen again.
//
// One parser, two apps, one contract: test/direct-share-contract.spec.ts runs
// this file and the real mobile parser over one corpus.

// Index of the first of any of `chars`, or -1. A loop over three characters is
// shorter here than the alternation regex would be, and it cannot throw.
function firstIndexOfAny(s: string, chars: string): number {
  let best = -1;
  for (const c of chars) {
    const i = s.indexOf(c);
    if (i !== -1 && (best === -1 || i < best)) best = i;
  }
  return best;
}

// Percent-decoding and the '+' form, by hand, because URLSearchParams is not
// available either: the RN shim's searchParams throws on get and getAll. A
// malformed escape must fail closed rather than throw, so the decode is in a
// try/catch.
function percentDecode(raw: string): string | null {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

// Every value the query carries for `name`, decoded, in order. The list, not
// the first value, is what lets the caller insist on EXACTLY ONE -- see below.
function queryValues(query: string, name: string): string[] {
  const out: string[] = [];
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if ((eq === -1 ? pair : pair.slice(0, eq)) !== name) continue;
    out.push(percentDecode(eq === -1 ? '' : pair.slice(eq + 1)) ?? '');
  }
  return out;
}

export function parseDirectShareRoute(url: string): DirectShareRoute | null {
  const schemeEnd = url.indexOf('://');
  if (schemeEnd === -1) return null;
  if (url.slice(0, schemeEnd).toLowerCase() !== 'daak') return null;

  // Authority runs to the first '?', '#' or '/'. A trailing slash is not a
  // segment, so `daak://send/?deviceId=...` still names the host `send`.
  const rest = url.slice(schemeEnd + 3);
  const authorityEnd = firstIndexOfAny(rest, '?#/');
  const authority = rest.slice(0, authorityEnd === -1 ? rest.length : authorityEnd);

  // USERINFO IS DELIBERATELY ALLOWED. `daak://user:pass@send?deviceId=...`
  // returns a route here and null on mobile (apps/mobile/src/deeplink.ts takes
  // the whole `user:pass@send` as the host and does not match `send`). The two
  // parsers disagree on this one input, desktop being the more permissive.
  // test/direct-share-contract.spec.ts pins the disagreement, so do not
  // 'fix' it: no caller mints a link with userinfo.
  const at = authority.indexOf('@');
  const hostAndPort = at === -1 ? authority : authority.slice(at + 1);

  // A port is not part of any daak link and no code downstream can act on one,
  // so it is a rejection rather than something quietly ignored. The colon is
  // looked for AFTER the userinfo, so a userinfo colon is not read as a port.
  if (hostAndPort.indexOf(':') !== -1) return null;

  // The host is case-insensitive and is lowercased HERE because nothing in this
  // parser case-folds it for us. `daak` is not a WHATWG special scheme, so the
  // old `new URL` path never lowercased a host either: without this,
  // daak://SEND and daak://send would mean two different things.
  if (hostAndPort.toLowerCase() !== 'send') return null;

  const tail = rest.slice(authorityEnd === -1 ? rest.length : authorityEnd);
  const queryAt = tail.indexOf('?');
  // The fragment is not part of the query and cannot reach the id, so it is
  // dropped rather than rejected.
  const query = queryAt === -1 ? '' : tail.slice(queryAt + 1).split('#')[0];

  // EXACTLY ONE device parameter, named `deviceId`.
  //
  // The NAME is not a preference. The Phase 6 plan says `device`, but the
  // shipped mobile parser reads `deviceId` (apps/mobile/src/deeplink.ts:47) and
  // apps/mobile/ios/Daak/Info.plist:28-38 already registers the `daak` scheme.
  // A committed, plist-wired parser outranks a plan line: with `device` there
  // was NO url either app would accept, so the link was dead in both
  // directions. test/direct-share-contract.spec.ts runs both REAL parsers over
  // one corpus so this cannot drift again.
  //
  // Exactly one, and not the first of several: `?deviceId=a&deviceId=b` names
  // two devices, and picking one silently is how a file goes to the wrong
  // peer. Mobile takes the first, so this is a second pinned divergence and
  // desktop is again the stricter of the two.
  const values = queryValues(query, 'deviceId');
  if (values.length !== 1) return null;
  const deviceId = values[0];
  return deviceId ? { deviceId } : null;
}
