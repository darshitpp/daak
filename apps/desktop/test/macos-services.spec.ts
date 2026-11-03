import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The Services entry is native code. No JavaScript suite can run it, so this
// test reads the source text and pins the names that the entry needs.
const read = (...parts: string[]) =>
  readFileSync(join(__dirname, '..', ...parts), 'utf8');

const plist = read('macos', 'Daak-macOS', 'Info.plist');
const delegate = read('macos', 'Daak-macOS', 'AppDelegate.mm');
const share = read('..', '..', 'modules', 'rn-share', 'macos', 'RNShare.mm');

describe('macOS Services entry', () => {
  it('declares the Send with Daak service in Info.plist', () => {
    expect(plist).toMatch(/<key>NSServices<\/key>/);
    expect(plist).toMatch(/<key>default<\/key>\s*<string>Send with Daak<\/string>/);
    expect(plist).toMatch(/<key>NSMessage<\/key>\s*<string>sendFiles<\/string>/);
    expect(plist).toMatch(/<key>NSPortName<\/key>\s*<string>\$\(PRODUCT_NAME\)<\/string>/);
    // Finder hides the entry without this empty dictionary.
    expect(plist).toMatch(/<key>NSRequiredContext<\/key>\s*<dict\/>/);
    expect(plist).toMatch(
      /<key>NSSendFileTypes<\/key>\s*<array>\s*<string>public\.item<\/string>\s*<\/array>/,
    );
  });

  it('sets the services provider after the super launch call', () => {
    const superAt = delegate.indexOf('[super applicationDidFinishLaunching:notification];');
    const providerAt = delegate.indexOf('NSApp.servicesProvider = self;');
    expect(superAt).toBeGreaterThan(-1);
    expect(providerAt).toBeGreaterThan(superAt);
  });

  it('handles sendFiles by storing the paths and opening the dashboard', () => {
    expect(delegate).toMatch(/- \(void\)sendFiles:\(NSPasteboard \*\)pboard\s+userData:\(NSString \*\)userData\s+error:\(NSString \*\*\)error/);
    expect(delegate).toMatch(/\[RNShare addPendingFiles:/);
    expect(delegate).toMatch(/\[\[RNWindowHost shared\] openDashboard\]/);
  });

  it('exports takePendingFiles and the event name from RNShare', () => {
    expect(share).toMatch(/RCT_EXPORT_METHOD\(takePendingFiles/);
    expect(share).toMatch(/supportedEvents[\s\S]*@"DaakServiceFilesPending"/);
  });

  // The source text of one Objective-C method, up to the next method or the end.
  const method = (src: string, signature: string): string => {
    const start = src.indexOf(signature);
    expect(start).toBeGreaterThan(-1);
    const next = src.slice(start + signature.length).search(/\n(?:[-+] \(|RCT_EXPORT_METHOD|@end)/);
    return next === -1 ? src.slice(start) : src.slice(start, start + signature.length + next);
  };

  it('addPendingFiles replaces the list and does not append', () => {
    const body = method(share, '+ (void)addPendingFiles:');
    expect(body).not.toMatch(/addObjectsFromArray/);
    expect(body).toMatch(/sPendingFiles = \[NSMutableArray arrayWithArray:paths\]/);
  });

  it('startObserving sends the pending event when the list is not empty', () => {
    const body = method(share, '- (void)startObserving');
    const observerAt = body.indexOf('addObserver:self');
    const sendAt = body.indexOf('sendEventWithName:kServiceFilesPending');
    expect(observerAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(observerAt);
    expect(body).toMatch(/sPendingFiles\.count > 0/);
  });

  it('dismissPendingFiles clears the list and posts the dismissed event', () => {
    const body = method(share, '+ (void)dismissPendingFiles');
    expect(body).toMatch(/@synchronized\(RNShare\.class\)/);
    expect(body).toMatch(/removeAllObjects/);
    expect(body).toMatch(/postNotificationName:kServiceFilesDismissed/);
  });

  it('RNShare forwards the dismissed event to JavaScript', () => {
    expect(share).toMatch(/kServiceFilesDismissed = @"DaakServiceFilesDismissed"/);
    expect(share).toMatch(/supportedEvents[\s\S]*@"DaakServiceFilesDismissed"/);
    const start = method(share, '- (void)startObserving');
    const stop = method(share, '- (void)stopObserving');
    expect(start).toMatch(/name:kServiceFilesDismissed/);
    expect(stop).toMatch(/name:kServiceFilesDismissed/);
  });

  it('AppDelegate clears the share when the dashboard window closes', () => {
    expect(delegate).toMatch(/NSWindowWillCloseNotification/);
    expect(delegate).toMatch(/object:self\.window/);
    expect(delegate).toMatch(/\[RNShare dismissPendingFiles\]/);
  });

  it('sendFiles guards the error out parameter', () => {
    expect(delegate).toMatch(/if \(error\) \{\s*\*error = /);
    expect(delegate.match(/\*error = /g)).toHaveLength(1);
  });

  it('every @synchronized in RNShare names RNShare.class', () => {
    const uses = share.match(/@synchronized\([^)]*\)/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(3);
    for (const use of uses) expect(use).toBe('@synchronized(RNShare.class)');
  });
});
