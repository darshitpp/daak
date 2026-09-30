/** A direct-share route: send these files to THIS device, not to a picker. */
export interface DirectShareRoute {
  deviceId: string;
}

// `new URL`, not the hand-rolled indexOf parser in apps/mobile/src/deeplink.ts.
// That one exists because HERMES has no URL and React Native's polyfill is
// Blob-only: it parses and then throws on the first accessor. Desktop runs on
// JavaScriptCore (and vitest runs on Node), where URL is real, so the stdlib
// class is both correct and shorter.
//
// Scheme and host are compared after the parser has lowercased them, which is
// why DAAK:// and daak://SEND are the SAME route here as on mobile, where both
// are explicitly lowercased before the comparison.
export function parseDirectShareRoute(url: string): DirectShareRoute | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // toLowerCase on the host is NOT redundant: URL only case-folds the host of a
  // SPECIAL scheme (http, https, ftp, file, ws, wss). daak is not one, so
  // daak://SEND parses to hostname "SEND". Mobile lowercases the host before
  // comparing (apps/mobile/src/deeplink.ts:50), and doing the same is what
  // keeps one link from meaning two different things in the two apps.
  if (parsed.protocol !== 'daak:' || parsed.hostname.toLowerCase() !== 'send') return null;
  // A port is not part of any daak link, and no code downstream can act on one,
  // so it is a rejection rather than something quietly ignored.
  if (parsed.port !== '') return null;
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
  // Exactly one, not get(): get() takes the first of `?deviceId=a&deviceId=b`,
  // and a link naming two devices is ambiguous -- picking one silently is how a
  // file goes to the wrong peer.
  if (parsed.searchParams.getAll('deviceId').length !== 1) return null;
  const deviceId = parsed.searchParams.get('deviceId');
  return deviceId ? { deviceId } : null;
}
