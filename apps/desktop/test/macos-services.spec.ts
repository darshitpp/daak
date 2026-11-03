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
});
