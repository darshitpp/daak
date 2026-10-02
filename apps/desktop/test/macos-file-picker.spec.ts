import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// macOS had NO file picker at all. RNShare.mm exported DaakSystemShare with
// exactly one method, share(), so the composer's "Add files" button could only
// fabricate a path -- and every file the user meant to send was never sent.
// iOS and Android both had one (UIDocumentPickerViewController /
// ACTION_OPEN_DOCUMENT) with ZERO production callers.
//
// What no JS test can see is pinned here: the native method exists at all, and
// it settles the promise in the panel's COMPLETION rather than blocking. A
// picker that resolved immediately (or never) looks identical to a working one
// from JavaScript -- the promise either resolves with an empty array forever,
// or the dashboard sits there while the chosen paths never reach engine.send.
const SHARE = readFileSync(
  join(__dirname, '..', '..', '..', 'modules', 'rn-share', 'macos', 'RNShare.mm'),
  'utf8',
);

// Comments stripped before every assertion, for the reason
// test/macos-inprocess-ffi.spec.ts records at length: these files EXPLAIN these
// exact identifiers in prose, so an unstripped `toContain` is satisfied by the
// essay rather than by the code. ObjC here uses // only (there are no /* */
// blocks in this file), and the strip leaves the newlines so line-oriented
// assertions still mean what they say.
const stripComments = (s: string): string => s.replace(/\/\/.*$/gm, '');
const code = stripComments(SHARE);

// Brace-balanced slice from `openAt` to the close of the block it opens.
// Nesting matters: the completion handler is a block inside the method, so a
// flat search for the next '}' lands on the handler's own close and truncates
// the range -- which is how a resolve() ends up reported as "outside the block"
// while the assertion says otherwise.
const blockEndAt = (src: string, openAt: number): number => {
  let depth = 0;
  for (let i = src.indexOf('{', openAt); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}' && --depth === 0) return i;
  }
  throw new Error(`unbalanced braces from ${openAt}`);
};

// The pickDocuments method's own body, brace-balanced from its opening brace,
// so no resolve() in a DIFFERENT method can satisfy an assertion here.
const methodBody = (): string => {
  const at = code.indexOf('RCT_EXPORT_METHOD(pickDocuments');
  expect(at).toBeGreaterThan(-1);
  const method = code.slice(at);
  return method.slice(0, blockEndAt(method, 0) + 1);
};

// The SHEET arm only: from beginSheetModalForWindow to the close of the
// statement it opens. A whole-body assertion cannot tell the sheet arm from
// the runModal fallback, so a sheet that resolved empty up front while the
// fallback still settled properly looked identical to a working picker --
// with the user watching their selection go nowhere.
const sheetArm = (): string => {
  const body = methodBody();
  const at = body.indexOf('beginSheetModalForWindow');
  expect(at).toBeGreaterThan(-1);
  return body.slice(at, blockEndAt(body, at) + 1);
};

describe('the macOS file picker exists and answers when the panel does', () => {
  it('exports pickDocuments on the module that is already registered', () => {
    // DaakSystemShare, NOT a new DaakShare: modules/rn-share/js/index.ts explains
    // in prose why the mobile and desktop modules must not share a barrel, and
    // adding a second module name here is the same mistake from the other side.
    expect(SHARE).toContain('RCT_EXPORT_MODULE(DaakSystemShare)');
    expect(code).toMatch(/RCT_EXPORT_METHOD\(pickDocuments\s*:\s*\(BOOL\)multiple/);
    // Promise-taking, like every other exported method: without resolve/reject in
    // the signature the JS call hangs forever, which is the exact failure the
    // next test rules out.
    expect(code).toMatch(
      /RCT_EXPORT_METHOD\(pickDocuments\s*:\s*\(BOOL\)multiple[\s\S]*?resolve\s*:\s*\(RCTPromiseResolveBlock\)resolve\s+reject\s*:\s*\(RCTPromiseRejectBlock\)reject\)/,
    );
  });

  // The one that matters. A sheet has no return value at all, so the ONLY place
  // its result can be read is the completion handler AppKit calls back with:
  // remove the handler and the panel opens, the user picks, and the promise never
  // settles -- invisible from JavaScript, and the composer just stops working.
  it('settles in the panel completion, not around a blocking run', () => {
    const body = methodBody();
    // The sheet path: anchored on a window when one is available.
    expect(body).toContain('beginSheetModalForWindow:');
    expect(body).toMatch(/beginSheetModalForWindow:[\s\S]*?completionHandler:/);
    // The fallback for no window at all. This app is LSUIElement with the
    // dashboard window ordered out at launch, so there frequently is none -- the
    // reason share() in this same file anchors on the tray instead.
    expect(body).toContain('runModal');
    // BOTH paths settle, and they settle in different places, so the method needs
    // more than one resolve: one inside the sheet completion handler, one on the
    // runModal branch. A single resolve() in the body would settle the sheet
    // case before the user had chosen anything and send an empty list.
    expect(body.match(/resolve\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  // And the handler has to be the thing that READS the panel. Not merely
  // present: `completionHandler:nil` plus a `resolve(@[])` next to the sheet
  // call is a picker that promises the user nothing while looking wired up --
  // the surviving mutation that turned this whole file green.
  it('reads the panel inside the sheet completion handler', () => {
    const arm = sheetArm();
    expect(arm).not.toMatch(/completionHandler\s*:\s*nil/);
    // The handler is a BLOCK, and it calls the reader (which calls the path
    // loop / resolve), so the result cannot exist outside the completion.
    expect(arm).toMatch(/completionHandler\s*:\s*\^\([\s\S]*?resolvePaths\(\)/);
    // Belt and braces: nothing in the sheet arm may settle the promise itself
    // before the user has chosen anything.
    expect(arm).not.toMatch(/resolve\(@\[\]\)/);
  });

  it('turns a dismissal into an empty list, not a rejection', () => {
    const body = methodBody();
    // A user closing a picker is not an error, and a reject here surfaces as a
    // red box in the shipped app over an ordinary Cancel click.
    expect(body).not.toContain('reject(');
    // The empty selection really does answer, rather than falling through and
    // hanging the composer: NSOpenPanel reports a Cancel as NO urls (its OK
    // button is disabled with nothing selected), so the empty check IS the
    // cancel check and there is no second branch to fall out of.
    expect(body).toMatch(/panel\.URLs\s*==\s*nil\s*\|\|\s*panel\.URLs\.count\s*==\s*0/);
    expect(body).toContain('resolve(@[])');
  });

  it('resolves the selection in order, as absolute paths', () => {
    const body = methodBody();
    // -path on NSURL, NOT -.filePath and NOT -absoluteString. The INTENT is
    // right -- engine.send takes filesystem paths and the composer's own
    // remove-<path> label reads them back -- but .filePath is the SWIFT bridge
    // name and does not exist in Objective-C: `property 'filePath' not found on
    // object of type 'NSURL *'`, which is a hard compile error the day anyone
    // builds the macOS app. This file is Objective-C; the picker had shipped
    // uncompiled long enough for the wrong-language accessor to pass a green
    // source pin that itself demanded .filePath.
    expect(body).toMatch(/\[paths addObject:url\.path\]/);
    // Anchored on the addObject: call so the selector is the thing under test,
    // not just the token appearing somewhere in the method body.
    expect(body).not.toMatch(/\.filePath/);
    // absoluteString is the other wrong answer: a percent-encoded file:// URL
    // is not a path, and it reaches engine.send as a nonexistent file.
    expect(body).not.toContain('absoluteString');
    // allowsMultipleSelection IS the `multiple` argument, or a button labelled
    // "Add files" quietly collects one file.
    expect(body).toMatch(/allowsMultipleSelection\s*=\s*multiple/);
    // Sanity on the slice itself, so the positives above cannot pass on a
    // brace-balance bug that captured an empty string.
    expect(body.trim().length).toBeGreaterThan(0);
  });

  // AppKit from a background queue is a hard crash, and this module is the one
  // place on macOS that drives it from an exported method. BOTH declarations
  // matter: requiresMainQueueSetup alone leaves methodQueue to the bridge's
  // default background queue.
  it('stays on the main queue', () => {
    expect(code).toMatch(/\+\s*\(BOOL\)requiresMainQueueSetup\s*\{\s*return YES;\s*\}/);
    expect(code).toMatch(/methodQueue[^}]*return dispatch_get_main_queue\(\)/);
    // And the runtime assertion, so a future methodQueue change is caught at
    // the call rather than at the first crash.
    expect(code).toContain('RCTAssertMainQueue();');
  });
});
